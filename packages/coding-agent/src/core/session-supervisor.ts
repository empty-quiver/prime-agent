import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import type { AgentSession } from "./agent-session.js";
import { DurableInbox } from "./durable-inbox.js";
import { DurableOutbox } from "./durable-outbox.js";
import { ExecutionBudget } from "./execution-budget.js";
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV, type SessionLease } from "./session-lease.js";

export interface SupervisorAnchor {
	version: 2;
	sessionId: string;
	sessionFile: string;
	budgetId: string;
	budgetFile: string;
	inboxId: string;
	outboxId: string;
}

function containedPath(root: string, value: string): string {
	if (!value || isAbsolute(value)) throw new Error("Supervisor paths must be relative to the state root");
	const path = realpathSync(resolve(root, value));
	const fromRoot = relative(root, path);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
		throw new Error("Supervisor path escaped the state root");
	return path;
}

/** Explicit one-time initialization only. Ordinary startup must never regenerate this anchor. */
export async function initializeSupervisorAnchor(path: string, session: AgentSession): Promise<void> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const root = realpathSync(dirname(path));
	const lease = acquireSessionLease(path, root, { [SESSION_LEASES_ENABLED_ENV]: "true" });
	try {
		if (existsSync(path)) throw new Error("Supervisor anchor already exists; refusing replacement");
		const sessionFile = session.sessionManager.getSessionFile();
		const budget = session.executionBudget;
		if (!sessionFile || !budget?.path) throw new Error("Supervisor requires a persisted session and budget");
		const state = await budget.snapshot();
		const inboxDirectory = resolve(root, "inbox");
		const inboxIdentity = resolve(inboxDirectory, ".identity");
		if (existsSync(inboxDirectory)) throw new Error("Inbox already exists; reconcile initialization before retrying");
		mkdirSync(inboxDirectory, { mode: 0o700 });
		const inboxId = randomUUID();
		writeFileAtomicSync(inboxIdentity, JSON.stringify(inboxId), { mode: 0o600, fsync: true, fsyncDir: true });
		const outboxDirectory = resolve(root, "outbox");
		if (existsSync(outboxDirectory))
			throw new Error("Outbox already exists; reconcile initialization before retrying");
		mkdirSync(outboxDirectory, { mode: 0o700 });
		const outboxId = randomUUID();
		writeFileAtomicSync(resolve(outboxDirectory, ".identity"), JSON.stringify(outboxId), {
			mode: 0o600,
			fsync: true,
			fsyncDir: true,
		});
		const anchor: SupervisorAnchor = {
			version: 2,
			inboxId,
			outboxId,
			sessionId: session.sessionId,
			sessionFile: relative(root, realpathSync(sessionFile)),
			budgetId: state.id,
			budgetFile: relative(root, budget.path),
		};
		containedPath(root, anchor.sessionFile);
		containedPath(root, anchor.budgetFile);
		writeFileAtomicSync(path, JSON.stringify(anchor), { mode: 0o600, fsync: true, fsyncDir: true });
	} finally {
		lease?.release();
	}
}

export interface SupervisorHealth {
	state: "idle" | "working" | "waiting" | "needs_reconciliation" | "budget_exhausted" | "stalled" | "stopping";
	sessionId: string;
	lastProgressAt: number;
	checkedAt: number;
	reason?: string;
	pendingMessages: number;
	heapUsed: number;
	rss: number;
}

export class SessionSupervisor {
	private lastProgressAt = Date.now();
	private stopping = false;
	private dispatch?: Promise<boolean>;
	private readonly unsubscribe: () => void;

	private constructor(
		readonly session: AgentSession,
		readonly inbox: DurableInbox,
		readonly outbox: DurableOutbox,
		private readonly budget: ExecutionBudget,
		private readonly lease: SessionLease | undefined,
		private readonly maxSilentMs: number,
	) {
		this.unsubscribe = session.subscribe(() => {
			this.lastProgressAt = Date.now();
		});
	}

	static async open(
		path: string,
		create: (sessionFile: string, budget: ExecutionBudget, outbox: DurableOutbox) => Promise<AgentSession>,
		maxSilentMs = 600_000,
	): Promise<SessionSupervisor> {
		if (!Number.isSafeInteger(maxSilentMs) || maxSilentMs < 1000 || maxSilentMs > 86_400_000)
			throw new Error("Invalid supervisor silence deadline");
		const root = realpathSync(dirname(path));
		const lease = acquireSessionLease(path, root, { [SESSION_LEASES_ENABLED_ENV]: "true" });
		let inbox: DurableInbox | undefined;
		let outbox: DurableOutbox | undefined;
		let budget: ExecutionBudget | undefined;
		let session: AgentSession | undefined;
		try {
			const anchor: SupervisorAnchor = JSON.parse(readFileSync(path, "utf8"));
			if (
				!anchor ||
				anchor.version !== 2 ||
				typeof anchor.sessionId !== "string" ||
				!anchor.sessionId ||
				typeof anchor.budgetId !== "string" ||
				!anchor.budgetId ||
				typeof anchor.sessionFile !== "string" ||
				typeof anchor.budgetFile !== "string"
			)
				throw new Error("Invalid supervisor anchor; refusing a new session");
			const sessionFile = containedPath(root, anchor.sessionFile);
			const budgetFile = containedPath(root, anchor.budgetFile);
			budget = new ExecutionBudget({}, budgetFile);
			if ((await budget.snapshot()).id !== anchor.budgetId) throw new Error("Supervisor budget identity changed");
			if (
				typeof anchor.inboxId !== "string" ||
				!anchor.inboxId ||
				JSON.parse(readFileSync(resolve(root, "inbox", ".identity"), "utf8")) !== anchor.inboxId
			)
				throw new Error("Supervisor inbox identity missing or changed");
			inbox = new DurableInbox(resolve(root, "inbox"));
			if (inbox.issues.length)
				throw new Error("Inbox delivery outcome unknown; reconcile before supervisor startup");
			if (
				typeof anchor.outboxId !== "string" ||
				!anchor.outboxId ||
				JSON.parse(readFileSync(resolve(root, "outbox", ".identity"), "utf8")) !== anchor.outboxId
			)
				throw new Error("Supervisor outbox identity missing or changed");
			outbox = new DurableOutbox(resolve(root, "outbox"));
			if (outbox.issues.length)
				throw new Error("Outbound send outcome unknown; reconcile before supervisor startup");
			// The factory constructs the saved session; it must not submit work or start external intake.
			session = await create(sessionFile, budget, outbox);
			if (session.sessionId !== anchor.sessionId || session.executionBudget !== budget)
				throw new Error("Supervisor session or budget identity changed");
			const supervisor = new SessionSupervisor(session, inbox, outbox, budget, lease, maxSilentMs);
			if (supervisor.health().state !== "needs_reconciliation" && !budget.signal.aborted) {
				await session.bindExtensions({});
				session.resumeWait();
			}
			return supervisor;
		} catch (error) {
			// Failed cleanup keeps both ownership leases quarantined in this process.
			if (session) await session.disposeAsync({ kernelSnapshot: false });
			inbox?.dispose();
			outbox?.dispose();
			budget?.dispose();
			lease?.release();
			throw error;
		}
	}

	health(now = Date.now()): SupervisorHealth {
		const wait = this.session.waitState;
		const busy = this.session.isSessionActive || this.session.hasPendingChildWork;
		let state: SupervisorHealth["state"] = busy ? "working" : "idle";
		let reason: string | undefined;
		if (wait && ["pending", "ready"].includes(wait.status)) {
			state = "waiting";
			reason = wait.reason;
		}
		if (busy && now - this.lastProgressAt > this.maxSilentMs) {
			state = "stalled";
			reason = "Active execution exceeded its no-progress deadline";
		}
		if (this.budget.signal.aborted) {
			state = "budget_exhausted";
			reason = this.budget.cachedState.exhausted ?? "Budget owner aborted";
		}
		if (
			this.session.recoveryIssues.length ||
			this.session.recoveryError ||
			this.inbox.issues.length ||
			this.inbox.error ||
			this.outbox.issues.length ||
			this.outbox.error ||
			this.session.waitError ||
			(wait?.status === "delivering" && !busy)
		) {
			state = "needs_reconciliation";
			reason =
				this.session.recoveryError ??
				this.outbox.error ??
				this.session.waitError ??
				this.inbox.error ??
				"An interrupted operation or wake has an unknown outcome";
		}
		if (this.stopping) state = "stopping";
		const memory = process.memoryUsage();
		return {
			state,
			reason,
			sessionId: this.session.sessionId,
			lastProgressAt: this.lastProgressAt,
			checkedAt: now,
			pendingMessages: this.inbox.pendingCount,
			heapUsed: memory.heapUsed,
			rss: memory.rss,
		};
	}

	async dispatchOne(): Promise<boolean> {
		if (this.dispatch) return this.dispatch;
		if (this.health().state !== "idle") return false;
		this.dispatch = this.inbox.dispatchNext(async (record) => {
			this.lastProgressAt = Date.now();
			await this.session.promptAndWait(record.text!, { internalPrompt: true, agentMessageId: record.id });
		});
		try {
			return await this.dispatch;
		} finally {
			this.dispatch = undefined;
		}
	}

	async close(): Promise<void> {
		this.stopping = true;
		this.session.agent.abort();
		await this.dispatch?.catch(() => undefined);
		await this.session.disposeAsync({ kernelSnapshot: false });
		this.unsubscribe();
		this.inbox.dispose();
		this.outbox.dispose();
		this.budget.dispose();
		this.lease?.release();
	}
}
