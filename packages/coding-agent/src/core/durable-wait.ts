import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV, type SessionLease } from "./session-lease.js";

export type WaitCondition =
	| { kind: "deadline"; deadline: number }
	| { kind: "job" | "child"; id: string; generation: string; deadline: number };
export type WaitOutcome = "completed" | "failed" | "cancelled" | "timeout" | "worker_crash";
export interface DurableWaitState {
	version: 1;
	id: string;
	condition: WaitCondition;
	reason: string;
	status: "pending" | "ready" | "delivering" | "acknowledged" | "cancelled";
	outcome?: WaitOutcome;
}

export function parseWaitCondition(value: unknown): WaitCondition {
	if (!value || typeof value !== "object") throw new Error("Invalid wait condition");
	const condition = value as Record<string, unknown>;
	if (!Number.isSafeInteger(condition.deadline) || (condition.deadline as number) < 0) {
		throw new Error("Wait requires an absolute deadline in epoch milliseconds");
	}
	if (condition.kind === "deadline") return { kind: "deadline", deadline: condition.deadline as number };
	if (
		(condition.kind === "job" || condition.kind === "child") &&
		typeof condition.id === "string" &&
		condition.id.length > 0 &&
		condition.id.length <= 512 &&
		typeof condition.generation === "string" &&
		condition.generation.length > 0 &&
		condition.generation.length <= 512
	) {
		return {
			kind: condition.kind,
			id: condition.id,
			generation: condition.generation,
			deadline: condition.deadline as number,
		};
	}
	throw new Error("Job and child waits require an id and generation");
}

/** A single leased session owns this file. A recovered delivery is never automatically replayed. */
export class DurableWait {
	private state?: DurableWaitState;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private deliveryOwner = false;
	private fault?: Error;
	private lease?: SessionLease;

	constructor(
		private readonly path: string | undefined,
		private readonly onReady: () => void,
	) {
		if (path) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			this.lease = acquireSessionLease(path, dirname(path), { [SESSION_LEASES_ENABLED_ENV]: "true" });
		}
		try {
			if (path && existsSync(path)) {
				const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!raw || typeof raw !== "object") throw new Error("Invalid durable wait state");
				const value = raw as Record<string, unknown>;
				if (
					value.version !== 1 ||
					typeof value.id !== "string" ||
					!value.id ||
					typeof value.reason !== "string" ||
					!["pending", "ready", "delivering", "acknowledged", "cancelled"].includes(String(value.status)) ||
					(value.outcome !== undefined &&
						!["completed", "failed", "cancelled", "timeout", "worker_crash"].includes(String(value.outcome)))
				) {
					throw new Error("Invalid durable wait state; refusing automatic recovery");
				}
				this.state = { ...(value as unknown as DurableWaitState), condition: parseWaitCondition(value.condition) };
			}
		} catch (error) {
			this.lease?.release();
			throw error;
		}
	}

	get paused(): boolean {
		return (
			this.fault !== undefined ||
			(!this.deliveryOwner &&
				this.state !== undefined &&
				["pending", "ready", "delivering"].includes(this.state.status))
		);
	}

	snapshot(): DurableWaitState | undefined {
		return this.state ? structuredClone(this.state) : undefined;
	}
	get error(): string | undefined {
		return this.fault?.message;
	}

	/** Call only after host initialization and recovery reconciliation have completed. */
	resume(): void {
		this.assertActive();
		this.arm();
	}

	start(condition: WaitCondition, reason: string): DurableWaitState {
		this.assertActive();
		if (this.state && ["pending", "ready", "delivering"].includes(this.state.status) && !this.deliveryOwner)
			throw new Error("A durable wait is already active");
		if (typeof reason !== "string" || !reason.trim() || reason.length > 4096)
			throw new Error("Wait requires a reason of at most 4096 characters");
		this.save({ version: 1, id: randomUUID(), condition: parseWaitCondition(condition), reason, status: "pending" });
		this.deliveryOwner = false;
		this.arm();
		return this.snapshot()!;
	}

	notify(id: string, kind: "job" | "child", target: string, generation: string, outcome: WaitOutcome): boolean {
		this.assertActive();
		const state = this.state;
		if (
			!state ||
			state.id !== id ||
			state.status !== "pending" ||
			state.condition.kind !== kind ||
			state.condition.id !== target ||
			state.condition.generation !== generation
		)
			return false;
		if (!["completed", "failed", "cancelled", "timeout", "worker_crash"].includes(outcome))
			throw new Error("Invalid wait outcome");
		this.save({ ...state, status: "ready", outcome });
		this.arm();
		return true;
	}

	claim(): DurableWaitState | undefined {
		this.assertActive();
		if (this.state?.status !== "ready") return undefined;
		this.save({ ...this.state, status: "delivering" });
		this.deliveryOwner = true;
		return this.snapshot();
	}

	acknowledge(id: string): void {
		this.assertActive();
		if (this.state?.id !== id) return; // The wake installed its next wait.
		if (!this.deliveryOwner || this.state?.id !== id || this.state.status !== "delivering")
			throw new Error("Wait delivery is not owned by this runtime");
		this.save({ ...this.state, status: "acknowledged" });
		this.deliveryOwner = false;
	}

	/** Operator reconciliation, not an automatic retry of a possibly executed wake. */
	cancel(): void {
		this.assertActive();
		if (this.state) this.save({ ...this.state, status: "cancelled" });
		this.deliveryOwner = false;
		clearTimeout(this.timer);
	}

	fail(error: unknown): void {
		this.deliveryOwner = false;
		this.fault = error instanceof Error ? error : new Error(String(error));
		clearTimeout(this.timer);
	}

	/** Stop callbacks while retaining ownership until host cleanup is confirmed. */
	quiesce(): void {
		this.disposed = true;
		clearTimeout(this.timer);
	}

	dispose(): void {
		this.quiesce();
		this.lease?.release();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Durable wait owner has been disposed");
		if (this.fault) throw this.fault;
	}
	private save(state: DurableWaitState): void {
		try {
			if (this.path) {
				mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
				writeFileAtomicSync(this.path, JSON.stringify(state), { mode: 0o600, fsync: true, fsyncDir: true });
			}
			this.state = state;
		} catch (error) {
			this.fail(error);
			throw error;
		}
	}
	private arm(): void {
		clearTimeout(this.timer);
		if (this.disposed || this.fault || !this.state) return;
		try {
			if (this.state.status === "pending") {
				const remaining = this.state.condition.deadline - Date.now();
				if (remaining > 0) {
					this.timer = setTimeout(() => this.arm(), Math.min(remaining, 2_147_483_647));
					this.timer.unref?.();
					return;
				}
				this.save({
					...this.state,
					status: "ready",
					outcome: this.state.condition.kind === "deadline" ? "completed" : "timeout",
				});
			}
			if (this.state.status === "ready") this.onReady();
		} catch (error) {
			this.fail(error);
		}
	}
}
