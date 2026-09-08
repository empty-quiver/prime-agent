import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { type KernelClient, ReplKernelManager } from "../src/core/kernel/index.js";
import { terminateOwnedChild } from "../src/core/kernel/terminate-child.js";
import { createIpythonToolDefinition, IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { createHarness } from "./suite/harness.js";

const directories: string[] = [];
const managers: ReplKernelManager[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const manager of managers.splice(0)) await manager.kill();
	for (const child of children.splice(0)) await terminateOwnedChild(child, { force: true });
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function stuckKernel(ignoreTerm: boolean) {
	const directory = mkdtempSync(join(tmpdir(), "prime-termination-test-"));
	directories.push(directory);
	const python = join(directory, "python.cjs");
	const cells = join(directory, "cells.jsonl");
	writeFileSync(
		python,
		`#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
if (${ignoreTerm}) process.on("SIGTERM", () => {});
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.type === "execute") fs.appendFileSync(${JSON.stringify(cells)}, JSON.stringify(request) + "\\n");
});
setInterval(() => {}, 1000);
process.stdout.write(JSON.stringify({ event: "ready", protocol: 3 }) + "\\n");
`,
	);
	chmodSync(python, 0o755);
	const manager = new ReplKernelManager({ python, cwd: directory });
	managers.push(manager);
	await manager.start();
	const child = Reflect.get(manager, "child") as ChildProcess;
	const readCells = () => {
		try {
			return readFileSync(cells, "utf8").trim().split("\n");
		} catch {
			return [];
		}
	};
	return { manager, child, readCells, directory };
}

describe("confirmed kernel termination", () => {
	it("does not report session disposal success when its kernel exit is unconfirmed", async () => {
		const harness = await createHarness({ tools: [] });
		try {
			Reflect.set(harness.session, "_ipythonKernelProvisioner", {
				dispose: async () => {
					throw new Error("exit unconfirmed");
				},
			});
			await expect(harness.session.disposeAsync()).rejects.toThrow("exit unconfirmed");
			expect(Reflect.get(harness.session, "_disposed")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
	it("quarantines failed startup when cleanup cannot confirm exit", async () => {
		const start = vi.spyOn(ReplKernelManager.prototype, "start").mockRejectedValue(new Error("startup failed"));
		const shutdown = vi
			.spyOn(ReplKernelManager.prototype, "shutdown")
			.mockRejectedValue(new Error("exit unconfirmed"));
		const kill = vi.spyOn(ReplKernelManager.prototype, "kill").mockResolvedValue();
		try {
			const provisioner = new IpythonKernelProvisioner(process.cwd(), {});
			await expect(provisioner.ensure()).rejects.toThrow("replacement blocked");
			const manager = provisioner.manager;
			expect(manager).toBeDefined();
			await expect(provisioner.ensure()).rejects.toThrow("replacement blocked");
			expect(start).toHaveBeenCalledTimes(1);
			await provisioner.kill();
			expect(kill).toHaveBeenCalledTimes(1);
			expect(provisioner.manager).toBeUndefined();
			shutdown.mockResolvedValue(true);
			await expect(provisioner.ensure()).rejects.toThrow("startup failed");
			expect(start).toHaveBeenCalledTimes(2);
		} finally {
			start.mockRestore();
			shutdown.mockRestore();
			kill.mockRestore();
		}
	});

	it("quarantines a failed dispose and refuses to boot its replacement", async () => {
		const manager = {
			shutdown: vi.fn(async () => {
				throw new Error("exit unconfirmed");
			}),
		} as unknown as KernelClient;
		const provisioner = new IpythonKernelProvisioner(process.cwd(), {});
		Object.assign(provisioner, { managerPromise: Promise.resolve(manager), startedManager: manager });
		const disposed = provisioner.dispose();
		const replacement = new IpythonKernelProvisioner(process.cwd(), {
			readyGate: disposed,
			python: "/must-not-execute",
		});
		await expect(disposed).rejects.toThrow("exit unconfirmed");
		expect(provisioner.manager).toBe(manager);
		await expect(provisioner.ensure()).rejects.toThrow("Python execution aborted");
		await expect(replacement.ensure()).rejects.toThrow("exit unconfirmed");
	});

	it("surfaces an asynchronous signal error without discarding the captured identity", async () => {
		const child = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => {
				queueMicrotask(() => child.emit("error", new Error("permission denied")));
				return false;
			}),
		});
		await expect(terminateOwnedChild(child as unknown as ChildProcess)).rejects.toThrow("permission denied");
		expect(child.listenerCount("exit")).toBe(0);
		expect(child.listenerCount("error")).toBe(0);
	});
	it.each([false, true])(
		"headless abort confirms exit, never replays the cell (ignore TERM=%s)",
		async (ignoreTerm) => {
			const { manager, child, readCells, directory } = await stuckKernel(ignoreTerm);
			const provisioner = new IpythonKernelProvisioner(directory, {});
			Object.assign(provisioner, { managerPromise: Promise.resolve(manager), startedManager: manager });
			const tool = createIpythonToolDefinition(directory, { provisioner });
			const controller = new AbortController();
			const execution = tool.execute("side-effect", { code: "send_once()" }, controller.signal, undefined, {
				hasUI: false,
			} as ExtensionContext);
			await vi.waitFor(() => expect(readCells()).toHaveLength(1));
			controller.abort();
			const result = await execution;
			expect(result.details.status).toBe("aborted");
			expect(result.details.error?.ename).toBe("KernelExecutionOutcomeUnknown");
			expect(result.details.error?.evalue).toContain("Reconcile before repeating");
			expect(child.signalCode).toBe(ignoreTerm ? "SIGKILL" : "SIGTERM");
			expect(manager.isDefunct).toBe(true);
			expect(readCells()).toHaveLength(1);
		},
		10_000,
	);

	it("shutdown escalates and waits for exit when protocol shutdown and TERM are ignored", async () => {
		const { manager, child } = await stuckKernel(true);
		await manager.shutdown();
		expect(child.signalCode).toBe("SIGKILL");
		expect(manager.isDefunct).toBe(true);
	}, 12_000);

	it("does not claim success if the child never confirms exit", async () => {
		const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) });
		await expect(
			terminateOwnedChild(child as unknown as ChildProcess, { graceMs: 5, forceWaitMs: 5 }),
		).rejects.toThrow("replacement is blocked");
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(child.listenerCount("exit")).toBe(0);
	});

	it("does not signal an already reaped ChildProcess", async () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		children.push(child);
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const kill = vi.spyOn(child, "kill");
		await terminateOwnedChild(child);
		expect(kill).not.toHaveBeenCalled();
	});

	it("a provisioner keeps its old manager and exposes an unconfirmed kill", async () => {
		const manager = {
			kill: vi.fn(async () => {
				throw new Error("exit unconfirmed");
			}),
			isDefunct: false,
		} as unknown as KernelClient;
		const provisioner = new IpythonKernelProvisioner(process.cwd(), {});
		Object.assign(provisioner, { managerPromise: Promise.resolve(manager), startedManager: manager });
		await expect(provisioner.kill()).rejects.toThrow("exit unconfirmed");
		expect(provisioner.manager).toBe(manager);
		await expect(provisioner.ensure()).resolves.toBe(manager);
	});

	it("concurrent ensure waits for kill confirmation instead of starting a replacement", async () => {
		let finishKill: () => void = () => {};
		const manager = {
			kill: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishKill = resolve;
					}),
			),
			isDefunct: false,
		} as unknown as KernelClient;
		const provisioner = new IpythonKernelProvisioner(process.cwd(), {});
		Object.assign(provisioner, { managerPromise: Promise.resolve(manager), startedManager: manager });
		const replacement = { isDefunct: false } as KernelClient;
		const start = vi.fn(async () => replacement);
		Reflect.set(provisioner, "startKernel", start);
		const killed = provisioner.kill();
		const ensured = provisioner.ensure();
		await vi.waitFor(() => expect(manager.kill).toHaveBeenCalledTimes(1));
		expect(start).not.toHaveBeenCalled();
		finishKill();
		await killed;
		await expect(ensured).resolves.toBe(replacement);
		expect(start).toHaveBeenCalledTimes(1);
	});
});
