import type { ChildProcess } from "node:child_process";

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function signalAndWait(child: ChildProcess, signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
	if (hasExited(child)) return true;
	return new Promise<boolean>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};
		const finish = (exited: boolean) => {
			cleanup();
			resolve(exited);
		};
		const onExit = () => finish(true);
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
		child.once("exit", onExit);
		child.once("error", onError);
		try {
			// Only signal the captured, unreaped ChildProcess. Never rediscover it by PID.
			child.kill(signal);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

/** Cleanup deliberately has no caller AbortSignal: cancellation cannot cancel cleanup. */
export async function terminateOwnedChild(
	child: ChildProcess,
	options: { force?: boolean; graceMs?: number; forceWaitMs?: number } = {},
): Promise<void> {
	if (hasExited(child)) return;
	if (!options.force && (await signalAndWait(child, "SIGTERM", options.graceMs ?? 1_000))) return;
	if (await signalAndWait(child, "SIGKILL", options.forceWaitMs ?? 5_000)) return;
	throw new Error("Kernel termination could not be confirmed; replacement is blocked");
}
