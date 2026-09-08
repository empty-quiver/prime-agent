/** Bound a host wait even when an extension/provider ignores cancellation. */
export function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	return new Promise<T>((resolve, reject) => {
		const aborted = () => {
			signal.removeEventListener("abort", aborted);
			reject(signal.reason ?? new Error("Operation cancelled"));
		};
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}
