import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecutionObserver, ToolExecutionReceipt } from "@earendil-works/pi-agent-core";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { journalFiles, readJournalJson } from "../utils/bounded-journal.js";

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
	private count = 0;
	readonly recoveredResults: OperationRecord[] = [];

	constructor(
		private readonly directory?: string,
		unfinished: Array<{ id: string; name: string }> = [],
	) {
		const expected = new Set(unfinished.map((call) => call.id));
		const covered = new Set<string>();
		if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
		for (const file of directory ? journalFiles(directory) : []) {
			if (++this.count > 100_000) throw new Error("Operation journal retention limit exceeded");
			const value = readJournalJson(join(directory!, file), 65_536);
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

	find(toolCallId: string): OperationRecord | undefined {
		this.assertReady();
		const active = [...this.unresolved.values()].find((record) => record.toolCallId === toolCallId);
		if (active) return structuredClone(active);
		if (!this.directory) return undefined;
		for (const file of journalFiles(this.directory)) {
			const record = readJournalJson(join(this.directory, file), 65_536) as OperationRecord;
			if (record.toolCallId === toolCallId) return record;
		}
		return undefined;
	}

	async beforeModel(): Promise<void> {
		this.assertReady();
	}

	async beforeTool(toolCallId: string, name: string): Promise<ToolExecutionReceipt> {
		this.assertReady();
		if (!toolCallId || toolCallId.length > 512 || !name || name.length > 512)
			throw new Error("Invalid operation identity");
		const record: OperationRecord = {
			version: 1,
			id: randomUUID(),
			generation: this.generation,
			toolCallId,
			name,
			status: "started",
			updatedAt: Date.now(),
		};
		this.save(record, true);
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
		this.save(
			{
				version: 1,
				id: randomUUID(),
				generation: "legacy",
				toolCallId,
				name,
				status: "unknown",
				updatedAt: Date.now(),
			},
			true,
		);
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

	private save(record: OperationRecord, isNew = false): void {
		try {
			if (isNew && this.count >= 100_000)
				throw new Error("Operation journal capacity exhausted; preserve recovery history");
			if (
				(record.status === "started" || record.status === "unknown") &&
				!this.unresolved.has(record.id) &&
				this.unresolved.size >= 1024
			)
				throw new Error("Operation journal pending limit exceeded");
			if (this.directory)
				writeFileAtomicSync(join(this.directory, `${record.id}.json`), JSON.stringify(record), {
					mode: 0o600,
					fsync: true,
					fsyncDir: true,
				});
			if (record.status === "started" || record.status === "unknown") this.unresolved.set(record.id, record);
			else this.unresolved.delete(record.id);
			if (isNew) this.count++;
		} catch (error) {
			this.fault = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}
}
