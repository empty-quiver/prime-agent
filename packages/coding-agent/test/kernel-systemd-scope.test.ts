import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { spawnKernelProcess } from "../src/core/kernel/systemd-scope.js";
import { terminateOwnedChild } from "../src/core/kernel/terminate-child.js";

const execute = promisify(execFile);
const linuxSupervisor = process.platform === "linux" && Boolean(process.env.PRIME_AGENT_SUPERVISOR_UNIT);

it("refuses requested containment without an active supervisor identity", () => {
	expect(() =>
		spawnKernelProcess(process.execPath, ["-e", "process.exit(0)"], {
			env: { ...process.env, PRIME_AGENT_KERNEL_SYSTEMD: "1", PRIME_AGENT_SUPERVISOR_UNIT: undefined },
		}),
	).toThrow(/requires/);
});

it.skipIf(!linuxSupervisor)(
	"confirms a TERM-resistant detached grandchild exits with its owned kernel scope",
	async () => {
		const script = `const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
setTimeout(() => process.stdout.write(JSON.stringify({ pid: grandchild.pid }) + '\\n'), 100);
setInterval(() => {}, 1000);`;
		const { child, ownershipReady } = spawnKernelProcess(process.execPath, ["-e", script], {
			env: { ...process.env, PRIME_AGENT_KERNEL_SYSTEMD: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const output = new Promise<number>((resolve, reject) => {
			let text = "";
			child.stdout?.on("data", (chunk) => {
				text += chunk.toString();
				if (text.includes("\n")) {
					try {
						resolve(JSON.parse(text.trim()).pid);
					} catch (error) {
						reject(error);
					}
				}
			});
			child.once("error", reject);
			child.once("exit", () => reject(new Error("Kernel fixture exited before reporting its child")));
		});
		try {
			await ownershipReady;
			const pid = await output;
			expect(Number.isInteger(pid)).toBe(true);
			const original = readFileSync(`/proc/${pid}/stat`, "utf8");
			await terminateOwnedChild(child);
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
			try {
				const current = readFileSync(`/proc/${pid}/stat`, "utf8");
				const previousFields = original.slice(original.lastIndexOf(")") + 2).split(" ");
				const currentFields = current.slice(current.lastIndexOf(")") + 2).split(" ");
				expect(currentFields[0] === "Z" || currentFields[19] !== previousFields[19]).toBe(true);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		} finally {
			await terminateOwnedChild(child, { force: true });
		}
	},
	20_000,
);

it.skipIf(!linuxSupervisor)(
	"confirms cleanup after a kernel exits before identity capture",
	async () => {
		for (let attempt = 0; attempt < 10; attempt++) {
			const { child, ownershipReady } = spawnKernelProcess(process.execPath, ["-e", "process.exit(17)"], {
				env: { ...process.env, PRIME_AGENT_KERNEL_SYSTEMD: "1" },
				stdio: "pipe",
			});
			try {
				await ownershipReady;
			} finally {
				await terminateOwnedChild(child, { force: true });
			}
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		}
	},
	20_000,
);

it.skipIf(!linuxSupervisor)(
	"stops the kernel scope when its supervisor crashes",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-scope-owner-test-"));
		const unit = `prime-scope-owner-test-${randomUUID()}.service`;
		const fixture = join(directory, "owner.mjs");
		const report = join(directory, "report.json");
		const scopeModule = fileURLToPath(new URL("../src/core/kernel/systemd-scope.ts", import.meta.url));
		writeFileSync(
			fixture,
			`import { spawnKernelProcess } from ${JSON.stringify(scopeModule)};
import { writeFileSync } from 'node:fs';
const { child, ownershipReady } = spawnKernelProcess(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { env: process.env, stdio: 'pipe' });
await ownershipReady;
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: child.pid }));
setInterval(() => {}, 1000);
`,
		);
		let invocation: string | undefined;
		try {
			await execute(
				"systemd-run",
				[
					"--user",
					"--collect",
					`--unit=${unit}`,
					"--property=KillMode=control-group",
					`--property=WorkingDirectory=${process.cwd()}`,
					"/usr/bin/env",
					"PRIME_AGENT_KERNEL_SYSTEMD=1",
					`PRIME_AGENT_SUPERVISOR_UNIT=${unit}`,
					`PATH=${process.env.PATH}`,
					process.execPath,
					"--import",
					"tsx",
					fixture,
				],
				{ timeout: 5_000 },
			);
			invocation = (
				await execute("systemctl", ["--user", "show", "--value", "--property=InvocationID", unit])
			).stdout.trim();
			expect(invocation).toMatch(/^[a-f0-9]{32}$/);
			await expect
				.poll(
					() => {
						try {
							return JSON.parse(readFileSync(report, "utf8")).pid as number;
						} catch {
							return undefined;
						}
					},
					{ timeout: 10_000 },
				)
				.toBeTypeOf("number");
			const pid: number = JSON.parse(readFileSync(report, "utf8")).pid;
			const cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("0::")[1];
			expect(cgroup).toMatch(/\/prime-kernel-[a-f0-9-]+\.scope$/);
			await execute("systemctl", ["--user", "kill", "--kill-whom=main", "--signal=SIGKILL", unit], {
				timeout: 2_000,
			});
			await expect
				.poll(
					() => {
						try {
							return /^populated 0$/m.test(
								readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.events"), "utf8"),
							);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
							throw error;
						}
					},
					{ timeout: 10_000 },
				)
				.toBe(true);
		} finally {
			if (invocation) {
				const current = await execute("systemctl", [
					"--user",
					"show",
					"--value",
					"--property=InvocationID",
					unit,
				]).catch(() => undefined);
				if (current?.stdout.trim() === invocation)
					await execute("systemctl", ["--user", "stop", unit], { timeout: 10_000 });
			}
			rmSync(directory, { recursive: true, force: true });
		}
	},
	30_000,
);
