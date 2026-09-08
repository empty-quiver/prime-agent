import type { ExtensionError } from "./types.js";

export interface ExtensionTimers {
	setTimeout(callback: () => unknown, delayMs?: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
	/** Skips ticks while the previous async callback is unsettled. */
	setInterval(callback: () => unknown, delayMs?: number): NodeJS.Timeout;
	clearInterval(handle: NodeJS.Timeout | undefined): void;
}

interface TimerRecord {
	ref: WeakRef<NodeJS.Timeout>;
	owner: string;
}

/** Error boundary and lifetime ownership for extension callbacks, not a sandbox. */
export class ExtensionTimerHost {
	private readonly records = new Set<TimerRecord>();
	private readonly handles = new WeakMap<NodeJS.Timeout, TimerRecord>();
	private readonly finalized = new FinalizationRegistry<TimerRecord>((record) => this.records.delete(record));
	private active = true;

	constructor(private report: (error: ExtensionError) => void) {}

	setReporter(report: (error: ExtensionError) => void): void {
		this.assertActive();
		this.report = report;
	}

	assertActive(): void {
		if (!this.active) throw new Error("This extension timer context is stale after unload or session disposal");
	}

	get size(): number {
		return this.records.size;
	}

	forOwner(owner: string): ExtensionTimers {
		return {
			setTimeout: (callback, delay) => this.schedule(owner, callback, delay, false),
			setInterval: (callback, delay) => this.schedule(owner, callback, delay, true),
			clearTimeout: (handle) => this.clear(handle, owner),
			clearInterval: (handle) => this.clear(handle, owner),
		};
	}

	private clear(handle: NodeJS.Timeout | undefined, owner?: string): void {
		if (!handle) return;
		const record = this.handles.get(handle);
		if (!record || (owner !== undefined && record.owner !== owner)) return;
		this.records.delete(record);
		this.handles.delete(handle);
		this.finalized.unregister(record);
		globalThis.clearTimeout(handle);
	}

	private schedule(owner: string, callback: () => unknown, delayMs = 1, repeat: boolean): NodeJS.Timeout {
		this.assertActive();
		if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
			throw new Error("Extension timer delay must be between 0 and 2147483647 milliseconds");
		}
		// Native clearTimeout is supported, but ctx.clearTimeout also releases registry capacity immediately.
		if (this.records.size >= 4096) throw new Error("Extension timer capacity exceeded (4096)");
		let running = false;
		const report = (error: unknown) => {
			try {
				this.report({
					extensionPath: owner,
					event: repeat ? "setInterval" : "setTimeout",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			} catch {
				// A diagnostic sink must never escape the callback boundary.
			}
		};
		const run = () => {
			if (!this.active || !this.handles.has(handle) || running) return;
			if (!repeat) this.clear(handle);
			running = true;
			try {
				Promise.resolve(callback()).then(
					() => {
						running = false;
					},
					(error) => {
						running = false;
						report(error);
					},
				);
			} catch (error) {
				running = false;
				report(error);
			}
		};
		const handle = repeat ? globalThis.setInterval(run, delayMs) : globalThis.setTimeout(run, delayMs);
		const record = { ref: new WeakRef(handle), owner };
		this.records.add(record);
		this.handles.set(handle, record);
		this.finalized.register(handle, record, record);
		return handle;
	}

	dispose(): void {
		this.active = false;
		for (const record of this.records) {
			const handle = record.ref.deref();
			if (handle) this.clear(handle);
			else this.finalized.unregister(record);
		}
		this.records.clear();
		this.report = () => {};
	}
}
