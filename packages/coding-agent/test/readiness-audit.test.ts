import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/core/event-log.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

const python = process.env.PRIME_AGENT_KERNEL_PYTHON!;
function record(value: object): void {
	if (process.env.PRIME_READINESS_RESULTS)
		appendFileSync(process.env.PRIME_READINESS_RESULTS, `${JSON.stringify(value)}\n`);
}

describe("three-fix candidate independent acceptance", () => {
	it("runs 2500 cells with 250 explicit snapshots and restores the saved namespace", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-readiness-soak-"));
		const snapshot = { path: join(dir, "state.dill"), manifestPath: join(dir, "state.json"), debounceMs: 60000 };
		const manager = new ReplKernelManager({ python, cwd: dir, snapshot });
		const restored = new ReplKernelManager({ python, cwd: dir, snapshot });
		const start = Date.now();
		try {
			for (let i = 0; i < 2500; i++) {
				const result = await manager.execute(`counter = ${i}\ncounter`, { signal: AbortSignal.timeout(10000) });
				expect(result.status).toBe("ok");
				expect(result.result).toBe(String(i));
				if (i % 10 === 9) expect(await manager.snapshotState()).not.toBeNull();
			}
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			await restored.start();
			expect((await restored.restoreState())?.restored).toContain("counter");
			expect((await restored.execute("counter")).result).toBe("2499");
			record({ probe: "soak", cells: 2500, explicitSnapshots: 250, elapsedMs: Date.now() - start });
		} finally {
			await manager.shutdown();
			await restored.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180000);

	it("replaces a crashed kernel and accepts subsequent execution", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-readiness-crash-"));
		const provisioner = new IpythonKernelProvisioner(dir, { python });
		try {
			const first = await provisioner.ensure();
			expect((await first.execute("6 * 7")).result).toBe("42");
			const crashed = await first.execute("import os\nos._exit(23)").then(
				() => "unexpected-success",
				(e: Error) => e.message,
			);
			const second = await provisioner.ensure();
			expect(second).not.toBe(first);
			expect((await second.execute("6 * 7")).result).toBe("42");
			record({ probe: "dead-kernel", cachedDeadManager: second === first, crash: crashed });
		} finally {
			await provisioner.dispose({ snapshot: false });
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30000);

	it("consistently treats an unterminated ledger record as uncommitted", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-readiness-ledger-"));
		try {
			const path = join(dir, "events.jsonl");
			writeFileSync(path, '{"id":1}\n{"id":2}');
			const log = new EventLog(path);
			const before = log.replaySync((line) => JSON.parse(line));
			expect(before).toEqual([{ id: 1 }]);
			log.appendSync([{ id: 3 }], { durable: true });
			const after = log.replaySync((line) => JSON.parse(line));
			expect(after).toEqual([{ id: 1 }, { id: 3 }]);
			record({ probe: "ledger-tail", before, after, finalBytes: readFileSync(path, "utf8").length });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("repairs a torn session tail before the first post-resume append", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-readiness-transcript-"));
		try {
			const path = join(dir, "session.jsonl");
			const header = {
				type: "session",
				version: 3,
				id: "audit-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			};
			const entry = {
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "prior response" }], timestamp: Date.now() },
			};
			writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n{"type":"message","id":"torn`);
			const session = SessionManager.open(path, dir);
			session.appendCustomEntry("audit_after_restart", { important: true });
			session.flushNow();
			const bytes = readFileSync(path, "utf8");
			const readable = loadEntriesFromFile(path);
			expect(bytes).toContain("audit_after_restart");
			expect(readable.some((item) => item.type === "custom" && item.customType === "audit_after_restart")).toBe(
				true,
			);
			record({ probe: "transcript-tail", newRecordOnDisk: true, newRecordReadable: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("an ordinary long cell remains pending until an external abort, then the kernel is reusable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-readiness-abort-"));
		const manager = new ReplKernelManager({ python, cwd: dir });
		const controller = new AbortController();
		try {
			await manager.start();
			const call = manager.execute("import time\ntime.sleep(600)", { signal: controller.signal });
			const marker = await Promise.race([
				call.then(() => "finished"),
				new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 500)),
			]);
			expect(marker).toBe("pending");
			controller.abort();
			expect((await call).status).toMatch(/aborted|error/);
			expect((await manager.execute("40 + 2", { signal: AbortSignal.timeout(10000) })).result).toBe("42");
		} finally {
			await manager.shutdown();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30000);
});
