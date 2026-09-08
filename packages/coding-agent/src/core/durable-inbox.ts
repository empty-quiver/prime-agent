import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { journalFiles, readJournalJson } from "../utils/bounded-journal.js";
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV, type SessionLease } from "./session-lease.js";

export interface InboxRecord {
	version: 1;
	id: string;
	digest: string;
	status: "received" | "dispatching" | "processed" | "unknown";
	text?: string;
	receivedAt: number;
	evidence?: string;
}

/** Durable at-most-once automatic dispatch. Unknown delivery requires operator reconciliation. */
export class DurableInbox {
	private readonly pending = new Map<string, InboxRecord>();
	private readonly lease: SessionLease | undefined;
	private count = 0;
	private closed = false;
	private fault?: Error;
	private dispatching = false;

	constructor(private readonly directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.lease = acquireSessionLease(join(directory, "owner"), directory, { [SESSION_LEASES_ENABLED_ENV]: "true" });
		try {
			for (const file of journalFiles(directory)) {
				if (++this.count > 100_000)
					throw new Error("Inbox retention limit exceeded; archive requires an explicit deduplication policy");
				const record = this.read(file);
				if (record.status === "dispatching") this.save({ ...record, status: "unknown" });
				else if (record.status !== "processed") this.pending.set(record.id, record);
				if (this.pending.size > 1000) throw new Error("Inbox pending limit exceeded");
			}
		} catch (error) {
			this.lease?.release();
			throw error;
		}
	}

	get issues(): InboxRecord[] {
		return [...this.pending.values()]
			.filter((record) => record.status === "unknown")
			.map((record) => ({ ...record }));
	}
	get pendingCount(): number {
		return this.pending.size;
	}
	get error(): string | undefined {
		return this.fault?.message;
	}
	lookup(id: string): InboxRecord | undefined {
		this.assertActive();
		const file = this.file(id);
		return existsSync(join(this.directory, file)) ? this.read(file) : undefined;
	}

	receive(id: string, text: string): "accepted" | "duplicate" {
		this.assertActive();
		if (!id || id.length > 512 || !text || Buffer.byteLength(text) > 262_144)
			throw new Error("Invalid inbox message size or identity");
		const digest = createHash("sha256").update(text).digest("hex");
		const file = this.file(id);
		if (existsSync(join(this.directory, file))) {
			const existing = this.read(file);
			if (existing.id !== id || existing.digest !== digest)
				throw new Error("Inbox message identity collision; refusing changed payload");
			return "duplicate";
		}
		if (this.count >= 100_000 || this.pending.size >= 1000)
			throw new Error("Inbox capacity exhausted; refusing to forget deduplication history");
		this.save({ version: 1, id, digest, text, status: "received", receivedAt: Date.now() });
		this.count++;
		return "accepted";
	}

	async dispatchNext(deliver: (record: InboxRecord) => Promise<void>, id?: string): Promise<boolean> {
		this.assertActive();
		if (this.dispatching) return false;
		if (this.issues.length) throw new Error("Inbox delivery outcome unknown; reconcile before dispatch");
		const next =
			id === undefined
				? [...this.pending.values()].find((record) => record.status === "received")
				: this.pending.get(id);
		if (!next || next.status !== "received") return false;
		this.dispatching = true;
		try {
			this.save({ ...next, status: "dispatching" });
			try {
				await deliver({ ...next, status: "dispatching" });
			} catch (error) {
				this.save({ ...next, status: "unknown" });
				throw error;
			}
			// A tombstone retains identity and digest, not the private message body.
			this.save({ ...next, text: undefined, status: "processed" });
			return true;
		} finally {
			this.dispatching = false;
		}
	}

	reconcile(id: string, outcome: "processed" | "received", evidence: string): void {
		this.assertActive();
		const record = this.pending.get(id);
		if (this.dispatching || record?.status !== "unknown")
			throw new Error("Only an inactive unknown delivery can be reconciled");
		if (!evidence.trim() || evidence.length > 4096) throw new Error("Inbox reconciliation requires evidence");
		this.save({ ...record, status: outcome, evidence, text: outcome === "processed" ? undefined : record.text });
	}

	dispose(): void {
		if (this.dispatching) throw new Error("Cannot release inbox ownership during dispatch");
		this.closed = true;
		this.lease?.release();
	}

	private assertActive(): void {
		if (this.closed) throw new Error("Inbox owner is closed");
		if (this.fault) throw this.fault;
	}
	private file(id: string): string {
		return `${createHash("sha256").update(id).digest("hex")}.json`;
	}
	private read(file: string): InboxRecord {
		const record = readJournalJson(join(this.directory, file), 2_097_152) as InboxRecord;
		if (
			!record ||
			record.version !== 1 ||
			typeof record.id !== "string" ||
			!record.id ||
			record.id.length > 512 ||
			file !== this.file(record.id) ||
			!/^[a-f0-9]{64}$/.test(record.digest) ||
			!Number.isSafeInteger(record.receivedAt) ||
			!["received", "dispatching", "processed", "unknown"].includes(record.status) ||
			(record.status !== "processed" &&
				(typeof record.text !== "string" ||
					!record.text ||
					Buffer.byteLength(record.text) > 262_144 ||
					createHash("sha256").update(record.text).digest("hex") !== record.digest))
		) {
			throw new Error("Invalid durable inbox record; refusing recovery");
		}
		return record;
	}
	private save(record: InboxRecord): void {
		try {
			writeFileAtomicSync(join(this.directory, this.file(record.id)), JSON.stringify(record), {
				mode: 0o600,
				fsync: true,
				fsyncDir: true,
			});
			if (record.status === "processed") this.pending.delete(record.id);
			else this.pending.set(record.id, record);
		} catch (error) {
			this.fault = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}
}
