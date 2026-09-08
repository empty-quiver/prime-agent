import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { verifyPinnedPython } from "../core/kernel/pinned-python.js";
import { verifySupervisorOwnership } from "../core/kernel/systemd-scope.js";
import { createAgentSession } from "../core/sdk.js";
import { SessionManager } from "../core/session-manager.js";
import { SessionSupervisor } from "../core/session-supervisor.js";
import { followSignalIntake, type SignalIntakeConfig } from "../core/signal-intake.js";
import { createSignalSendTool, type SignalSendConfig } from "../core/signal-send.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { sleep } from "../utils/sleep.js";

interface Config {
	anchor: string;
	cwd: string;
	agentDir: string;
	pythonManifest: string;
	pythonManifestSha256: string;
	sourceRoot: string;
	maxSilentMs?: number;
	signal?: SignalIntakeConfig;
	signalOutbound?: SignalSendConfig;
}

const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let supervisor: SessionSupervisor | undefined;
let intake: Promise<void> | undefined;
let intakeError: unknown;
let intakeStatus = "disabled";
let exitCode = 78;

async function notify(...values: string[]): Promise<void> {
	if (process.env.NOTIFY_SOCKET) await promisify(execFile)("/usr/bin/systemd-notify", values, { timeout: 2000 });
}

try {
	const configPath = process.argv[2];
	if (!configPath || !isAbsolute(configPath)) throw new Error("Provide an absolute supervisor config path");
	const config: Config = JSON.parse(readFileSync(configPath, "utf8"));
	if (
		!config ||
		![config.anchor, config.cwd, config.agentDir].every((value) => typeof value === "string" && isAbsolute(value))
	)
		throw new Error("Supervisor config requires absolute anchor, cwd and agentDir paths");
	if (
		process.platform !== "linux" ||
		process.env.PRIME_AGENT_KERNEL_SYSTEMD !== "1" ||
		!process.env.PRIME_AGENT_SUPERVISOR_UNIT
	)
		throw new Error("Supervised execution requires Linux systemd kernel containment");
	if (!process.env.PRIME_AGENT_KERNEL_PYTHON || !isAbsolute(process.env.PRIME_AGENT_KERNEL_PYTHON))
		throw new Error("Supervised execution requires an explicitly provisioned pinned Python runtime");
	verifySupervisorOwnership();
	if (
		![config.pythonManifest, config.sourceRoot].every((value) => typeof value === "string" && isAbsolute(value)) ||
		typeof config.pythonManifestSha256 !== "string"
	)
		throw new Error("Supervisor requires a sealed Python manifest and source root");
	await notify("WATCHDOG=1", "STATUS=Verifying pinned runtime");
	await verifyPinnedPython(
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		config.pythonManifest,
		config.pythonManifestSha256,
		config.sourceRoot,
		abort.signal,
	);
	process.env.PRIME_AGENT_KERNEL_MANIFEST = config.pythonManifest;
	process.env.PRIME_AGENT_KERNEL_MANIFEST_SHA256 = config.pythonManifestSha256;
	process.env.PRIME_AGENT_PINNED_SOURCE_ROOT = config.sourceRoot;
	supervisor = await SessionSupervisor.open(
		config.anchor,
		async (file, budget, outbox) => {
			const manager = SessionManager.open(file);
			const expected = manager.buildSessionContext().model;
			const result = await createAgentSession({
				cwd: config.cwd,
				agentDir: config.agentDir,
				sessionManager: manager,
				executionBudget: budget,
				customTools: config.signalOutbound ? [createSignalSendTool(config.signalOutbound, outbox)] : [],
				prewarmIpythonKernel: false,
			});
			if (
				!expected ||
				result.modelFallbackMessage ||
				result.session.model?.provider !== expected.provider ||
				result.session.model?.id !== expected.modelId
			) {
				await result.session.disposeAsync({ kernelSnapshot: false });
				throw new Error("Saved model could not be restored; refusing unattended model fallback");
			}
			return result.session;
		},
		config.maxSilentMs,
	);
	exitCode = 75;
	if (config.signal) {
		intake = followSignalIntake(config.signal, supervisor.inbox, abort.signal, (status) => {
			intakeStatus = status;
		}).catch((error: unknown) => {
			intakeError = error;
			abort.abort();
		});
	}
	await notify("READY=1", "STATUS=Restored anchored session");
	while (!abort.signal.aborted) {
		const health = supervisor.health();
		writeFileAtomicSync(join(dirname(config.anchor), "health.json"), JSON.stringify({ ...health, intakeStatus }), {
			mode: 0o600,
			fsync: true,
			fsyncDir: true,
		});
		await notify("WATCHDOG=1", `STATUS=${health.state}`);
		if (health.state === "stalled") throw new Error(health.reason);
		if (health.state === "idle")
			void supervisor.dispatchOne().catch((error: unknown) => {
				intakeError = error;
				abort.abort();
			});
		await sleep(5000, abort.signal).catch((error: unknown) => {
			if (!abort.signal.aborted) throw error;
		});
	}
	if (intakeError) throw intakeError;
	exitCode = 0;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
} finally {
	abort.abort();
	// systemd owns the final containment boundary if cleanup cannot finish.
	const deadline = setTimeout(() => process.exit(75), 35_000);
	try {
		await intake;
		await supervisor?.close();
	} catch (error) {
		exitCode = 75;
		console.error(`Cleanup unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(deadline);
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}
process.exit(exitCode);
