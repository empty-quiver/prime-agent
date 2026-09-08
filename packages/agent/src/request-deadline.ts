/** Host deadline, independent of provider cooperation and tool execution time. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

export class ProviderTimeoutError extends Error {
	readonly kind = "timeout";
	readonly retrySafe = false;
	constructor(timeoutMs: number) {
		super(`Provider request exceeded ${timeoutMs} ms; remote completion and expenditure may be unknown`);
		this.name = "ProviderTimeoutError";
	}
}

export interface RequestDeadline {
	signal: AbortSignal;
	dispose(): void;
}

export function createRequestDeadline(parent?: AbortSignal, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS): RequestDeadline {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
		throw new Error("providerTimeoutMs must be an integer between 1 and 2147483647");
	}
	const controller = new AbortController();
	const cancelled = () => controller.abort(parent?.reason);
	parent?.addEventListener("abort", cancelled, { once: true });
	if (parent?.aborted) cancelled();
	const timer = setTimeout(() => controller.abort(new ProviderTimeoutError(timeoutMs)), timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", cancelled);
		},
	};
}
