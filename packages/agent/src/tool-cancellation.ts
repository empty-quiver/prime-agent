export type ToolCancellationJoin =
	| { status: "settled" }
	| { status: "failed"; error: string }
	| { status: "unconfirmed" };

export function validateCancellationGrace(value = 0): number {
	if (!Number.isInteger(value) || value < 0 || value > 30_000) {
		throw new Error("cancellationGraceMs must be an integer between 0 and 30000");
	}
	return value;
}

/** Join cleanup independently of the already-aborted execution signal. */
export async function joinCancelledTool(operation: Promise<unknown>, graceMs: number): Promise<ToolCancellationJoin> {
	const settled = operation.then<ToolCancellationJoin, ToolCancellationJoin>(
		() => ({ status: "settled" }),
		(error: unknown) => ({ status: "failed", error: error instanceof Error ? error.message : String(error) }),
	);
	if (graceMs === 0) return { status: "unconfirmed" };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			settled,
			new Promise<ToolCancellationJoin>((resolve) => {
				timer = setTimeout(() => resolve({ status: "unconfirmed" }), graceMs);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
