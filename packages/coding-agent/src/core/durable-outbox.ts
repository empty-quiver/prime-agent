import { UnknownOperationError } from "@earendil-works/pi-agent-core";
import { DurableInbox } from "./durable-inbox.js";

/** Local at-most-once automatic sending, not a remote exactly-once guarantee. */
export class DurableOutbox {
	private readonly journal: DurableInbox;
	private tail: Promise<unknown> = Promise.resolve();
	private queued = 0;
	constructor(directory: string) {
		this.journal = new DurableInbox(directory);
	}
	get issues() {
		return this.journal.issues;
	}
	get error(): string | undefined {
		return this.journal.error;
	}

	async send(
		id: string,
		payload: string,
		deliver: () => Promise<void>,
		signal?: AbortSignal,
	): Promise<"sent" | "already_sent"> {
		if (this.queued >= 1000) throw new Error("Outbox dispatch queue is full");
		signal?.throwIfAborted();
		this.journal.receive(id, payload);
		this.queued++;
		const operation = this.tail.then(async () => {
			signal?.throwIfAborted();
			if (this.journal.lookup(id)?.status === "processed") return "already_sent" as const;
			const sent = await this.journal.dispatchNext(async () => {
				await deliver();
			}, id);
			if (!sent) throw new Error("Outbox dispatch is unavailable; reconcile before retrying");
			return "sent" as const;
		});
		this.tail = operation.catch(() => undefined);
		try {
			return await operation;
		} catch (error) {
			if (this.journal.issues.length || this.journal.error)
				throw new UnknownOperationError(error instanceof Error ? error.message : String(error), { cause: error });
			throw error;
		} finally {
			this.queued--;
		}
	}

	reconcile(id: string, outcome: "processed" | "received", evidence: string): void {
		if (this.queued) throw new Error("Outbox reconciliation requires idle dispatch");
		this.journal.reconcile(id, outcome, evidence);
	}
	dispose(): void {
		if (this.queued) throw new Error("Outbox ownership cannot be released during dispatch");
		this.journal.dispose();
	}
}
