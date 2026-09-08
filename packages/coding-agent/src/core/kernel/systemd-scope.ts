import { type ChildProcess, execFile, execFileSync, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sleep } from "../../utils/sleep.js";

const execute = promisify(execFile);
const scopes = new WeakMap<ChildProcess, Promise<ScopeIdentity | undefined>>();
interface ScopeIdentity {
	unit: string;
	invocation: string;
	cgroup: string;
}
const properties = ["--property=InvocationID,ControlGroup,ActiveState,LoadState,KillMode"];

function fields(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
	);
}

async function inspect(unit: string): Promise<Record<string, string>> {
	try {
		return fields((await execute("systemctl", ["--user", "show", unit, ...properties], { timeout: 2_000 })).stdout);
	} catch (error) {
		if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string") {
			const result = fields(error.stdout);
			if (result.LoadState === "not-found") return result;
		}
		throw new Error(`Cannot inspect owned kernel scope ${unit}`);
	}
}

async function capture(unit: string, child: ChildProcess): Promise<ScopeIdentity | undefined> {
	if (child.pid === undefined) throw new Error("Kernel scope launcher did not start");
	const deadline = Date.now() + 10_000;
	do {
		const state = await inspect(unit);
		if (
			/^[a-f0-9]{32}$/.test(state.InvocationID ?? "") &&
			state.ControlGroup?.endsWith(`/${unit}`) &&
			state.ControlGroup.startsWith("/") &&
			!state.ControlGroup.split("/").includes("..")
		) {
			return { unit, invocation: state.InvocationID, cgroup: state.ControlGroup };
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			// A collected scope cannot retain processes. Query after launcher exit;
			// a pre-exit not-found response can race scope creation.
			const final = await inspect(unit);
			if (final.LoadState === "not-found") return undefined;
			if (["inactive", "failed"].includes(final.ActiveState) && !final.ControlGroup) return undefined;
		}
		await sleep(25);
	} while (Date.now() < deadline);
	throw new Error("Kernel scope identity was not confirmed; replacement is blocked");
}

/** Scopes inherit the caller environment directly: no credential-bearing CLI arguments or env files. */
export function spawnKernelProcess(
	command: string,
	args: string[],
	options: SpawnOptions,
): {
	child: ChildProcess;
	ownershipReady?: Promise<void>;
} {
	const environment = options.env ?? process.env;
	if (environment.PRIME_AGENT_KERNEL_SYSTEMD !== "1") return { child: spawn(command, args, options) };
	if (process.platform !== "linux") throw new Error("Kernel systemd containment requires Linux");
	const parent = environment.PRIME_AGENT_SUPERVISOR_UNIT;
	if (!parent || !/^[A-Za-z0-9_.@:-]+\.service$/.test(parent))
		throw new Error("Kernel containment requires a supervisor service unit");
	const parentState = fields(
		execFileSync("systemctl", ["--user", "show", parent, ...properties], { encoding: "utf8", timeout: 2_000 }),
	);
	if (parentState.ActiveState !== "active" || !/^[a-f0-9]{32}$/.test(parentState.InvocationID ?? "")) {
		throw new Error("Supervisor service identity is not active");
	}
	const membership = readFileSync("/proc/self/cgroup", "utf8")
		.split("\n")
		.find((line) => line.startsWith("0::"))
		?.slice(3);
	if (
		!parentState.ControlGroup ||
		parentState.KillMode !== "control-group" ||
		(membership !== parentState.ControlGroup && !membership?.startsWith(`${parentState.ControlGroup}/`))
	) {
		throw new Error("Kernel owner is not contained by the declared supervisor service");
	}
	const unit = `prime-kernel-${randomUUID()}.scope`;
	const child = spawn(
		"systemd-run",
		[
			"--user",
			"--scope",
			"--quiet",
			`--unit=${unit}`,
			"--expand-environment=no",
			"--property=KillMode=control-group",
			"--property=TimeoutStopSec=5s",
			"--property=SendSIGKILL=yes",
			`--property=BindsTo=${parent}`,
			`--property=After=${parent}`,
			"--",
			command,
			...args,
		],
		options,
	);
	const identity = capture(unit, child);
	void identity.catch(() => undefined);
	scopes.set(child, identity);
	return { child, ownershipReady: identity.then(() => undefined) };
}

function empty(identity: ScopeIdentity): boolean {
	try {
		return /^populated 0$/m.test(readFileSync(join("/sys/fs/cgroup", identity.cgroup, "cgroup.events"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		if ((error as NodeJS.ErrnoException).code === "ENODEV") return false;
		throw new Error("Could not confirm kernel cgroup exit", { cause: error });
	}
}

async function verify(identity: ScopeIdentity): Promise<boolean> {
	if (empty(identity)) return true;
	const current = await inspect(identity.unit);
	if (empty(identity)) return true;
	if (current.InvocationID !== identity.invocation || current.ControlGroup !== identity.cgroup) {
		throw new Error("Kernel scope generation changed; refusing to signal an unowned unit");
	}
	return false;
}

async function signalScope(identity: ScopeIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
	try {
		await execute("systemctl", ["--user", "kill", "--kill-whom=all", `--signal=${signal}`, identity.unit], {
			timeout: 2_000,
		});
	} catch (error) {
		if (!empty(identity)) throw error;
	}
}

/** Signals the verified scope, including detached descendants. Cleanup never uses the caller's aborted signal. */
export async function terminateKernelScope(child: ChildProcess, force: boolean): Promise<void> {
	if (child.pid === undefined && typeof child.spawnfile === "string") {
		scopes.delete(child);
		return;
	}
	const pending = scopes.get(child);
	if (!pending) return;
	const identity = await pending;
	if (!identity) {
		scopes.delete(child);
		return;
	}
	if (!(await verify(identity))) {
		if (!force) {
			await signalScope(identity, "SIGTERM");
			const grace = Date.now() + 1_000;
			while (!empty(identity) && Date.now() < grace) await sleep(25);
		}
		if (!(await verify(identity))) {
			await signalScope(identity, "SIGKILL");
		}
		const deadline = Date.now() + 5_000;
		while (!empty(identity) && Date.now() < deadline) await sleep(25);
		if (!empty(identity)) throw new Error("Kernel descendants have not exited; replacement is blocked");
	}
	scopes.delete(child);
}
