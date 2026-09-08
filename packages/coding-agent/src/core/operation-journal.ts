import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecutionObserver, ToolExecutionReceipt } from "@earendil-works/pi-agent-core";
import { writeFileAtomicSync } from "../utils/atomic-file.js";

export interface OperationRecord {
	version: 1;
	id: string;
	generation: string;
	toolCallId: string;
	name: string;
	status: "started" | "succeeded" | "failed" | "unknown";
	updatedAt: number;
	reconciliation?: string;
}

/** The session lease must be held before constructing this journal. No arguments or credentials are recorded. */
export class OperationJournal implements AgentExecutionObserver {
	private readonly generation = randomUUID();
	private readonly unresolved = new Map<string, OperationRecord>();
	private fault?: Error;
	private closed = false;
	readonly recoveredResults: OperationRecord[] = [];

	constructor(
		private readonly directory?: string,
		unfinished: Array<{ id: string; name: string }> = [],
	) {
		const expected = new Set(unfinished.map((call) => call.id));
		const covered = new Set<string>();
		if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
		for (const file of directory ? readdirSync(directory) : []) {
			if (!file.endsWith(".json")) continue;
			const value: unknown = JSON.parse(readFileSync(join(directory!, file), "utf8"));
			if (!value || typeof value !== "object") throw new Error("Invalid operation journal");
			const record = value as OperationRecord;
			if (
				record.version !== 1 ||
				!/^[a-f0-9-]{36}$/.test(record.id) ||
				file !== `${record.id}.json` ||
				typeof record.generation !== "string" ||
				typeof record.toolCallId !== "string" ||
				typeof record.name !== "string" ||
				!Number.isSafeInteger(record.updatedAt) ||
				!["started", "succeeded", "failed", "unknown"].includes(record.status)
			) {
				throw new Error("Invalid operation journal; recovery requires reconciliation");
			}
			if (record.status === "started" || record.status === "unknown") {
				this.save({ ...record, status: "unknown" });
			} else if (expected.has(record.toolCallId)) {
				this.recoveredResults.push(record);
			}
			if (expected.has(record.toolCallId)) covered.add(record.toolCallId);
		}
		for (const call of unfinished) if (!covered.has(call.id)) this.importUnfinished(call.id, call.name);
	}

	issues(): OperationRecord[] {
		return [...this.unresolved.values()].map((record) => structuredClone(record));
	}
	get error(): string | undefined {
		return this.fault?.message;
	}

	async beforeModel(): Promise<void> {
		this.assertReady();
	}

	async beforeTool(toolCallId: string, name: string): Promise<ToolExecutionReceipt> {
		this.assertReady();
		const record: OperationRecord = {
			version: 1,
			id: randomUUID(),
			generation: this.generation,
			toolCallId,
			name,
			status: "started",
			updatedAt: Date.now(),
		};
		this.save(record);
		let settled = false;
		return {
			settle: async (outcome) => {
				if (settled || this.closed) return;
				if (this.unresolved.get(record.id)?.status !== "started") return;
				if (outcome === "unknown") {
					this.interruptActive();
					settled = true;
					return;
				}
				this.save({ ...record, status: outcome, updatedAt: Date.now() });
				settled = true;
			},
		};
	}

	interruptActive(): void {
		for (const record of this.unresolved.values()) {
			if (record.status === "started") this.save({ ...record, status: "unknown", updatedAt: Date.now() });
		}
	}

	/** Host/operator evidence is required; models are not given a reconciliation tool. */
	reconcile(id: string, outcome: "succeeded" | "failed", evidence: string): void {
		if (this.closed || this.fault) throw new Error("Operation journal is unavailable");
		const record = this.unresolved.get(id);
		if (!record || record.status !== "unknown") throw new Error("Only unknown operations can be reconciled");
		if (!evidence.trim() || evidence.length > 4096)
			throw new Error("Reconciliation requires evidence of at most 4096 characters");
		this.save({ ...record, status: outcome, reconciliation: evidence, updatedAt: Date.now() });
	}

	/** Imports an unfinished operation from a legacy transcript once. */
	importUnfinished(toolCallId: string, name: string): void {
		if ([...this.unresolved.values()].some((record) => record.toolCallId === toolCallId)) return;
		this.save({
			version: 1,
			id: randomUUID(),
			generation: "legacy",
			toolCallId,
			name,
			status: "unknown",
			updatedAt: Date.now(),
		});
	}

	dispose(): void {
		this.closed = true;
	}

	private assertReady(): void {
		if (this.closed) throw new Error("Operation journal owner is closed");
		if (this.fault) throw this.fault;
		const unknown = [...this.unresolved.values()].filter((record) => record.status === "unknown");
		if (unknown.length)
			throw new Error(
				`Outcome unknown for ${unknown.length} interrupted operation(s); reconcile recoveryIssues before continuing`,
			);
	}

	private save(record: OperationRecord): void {
		try {
			if (this.directory)
				writeFileAtomicSync(join(this.directory, `${record.id}.json`), JSON.stringify(record), {
					mode: 0o600,
					fsync: true,
					fsyncDir: true,
				});
			if (record.status === "started" || record.status === "unknown") this.unresolved.set(record.id, record);
			else this.unresolved.delete(record.id);
		} catch (error) {
			this.fault = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}
}
