/** Keeps only unsettled deliveries; completed streaming updates must not retain promises. */
export class PendingEvents {
	private readonly pending = new Set<Promise<void>>();
	private failed = false;
	private error: unknown;

	get size(): number {
		return this.pending.size;
	}

	add(delivery: void | Promise<void>): void {
		if (!delivery) return;
		const tracked = Promise.resolve(delivery).then(
			() => {
				this.pending.delete(tracked);
			},
			(error) => {
				this.pending.delete(tracked);
				if (!this.failed) {
					this.failed = true;
					this.error = error;
				}
			},
		);
		this.pending.add(tracked);
	}

	async settle(): Promise<void> {
		await Promise.all(this.pending);
		if (this.failed) throw this.error;
	}
}
