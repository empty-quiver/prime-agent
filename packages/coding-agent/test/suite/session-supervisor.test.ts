import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { ExecutionBudget } from "../../src/core/execution-budget.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import {
	initializeSupervisorAnchor,
	SessionSupervisor,
	type SupervisorAnchor,
} from "../../src/core/session-supervisor.js";
import { createHarness, type Harness } from "./harness.js";

async function seed() {
	const harness = await createHarness({
		tools: [],
		persistSession: true,
		autonomous: { enabled: true, maxTurns: 20 },
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	harness.session.setSessionName("supervisor fixture");
	const path = join(harness.tempDir, "supervisor.json");
	await initializeSupervisorAnchor(path, harness.session);
	return { harness, path };
}

function factory(harness: Harness, cwd = harness.tempDir) {
	return async (sessionFile: string, executionBudget: ExecutionBudget) =>
		(
			await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.open(sessionFile),
				executionBudget,
				model: harness.getModel(),
				modelRegistry: harness.session.modelRegistry,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				noTools: "all",
				autonomous: { enabled: false },
			})
		).session;
}

it("restores the same copied session, budget, waits and inbox under one active owner", async () => {
	const { harness, path } = await seed();
	const copyRoot = mkdtempSync(join(tmpdir(), "prime-supervisor-copy-"));
	let supervisor: SessionSupervisor | undefined;
	try {
		harness.session.startWait({ kind: "deadline", deadline: Date.now() + 500 }, "wake after restart");
		const sessionId = harness.session.sessionId;
		const budgetId = harness.session.executionBudget!.cachedState.id;
		await harness.session.disposeAsync();
		const family = join(copyRoot, "family");
		cpSync(harness.tempDir, family, { recursive: true });
		harness.setResponses([fauxAssistantMessage("awake"), fauxAssistantMessage("inbox processed")]);
		const copiedPath = join(family, "supervisor.json");
		supervisor = await SessionSupervisor.open(copiedPath, factory(harness, family));
		expect(supervisor.session.sessionId).toBe(sessionId);
		expect(supervisor.session.executionBudget!.cachedState.id).toBe(budgetId);
		const other = vi.fn(factory(harness, family));
		await expect(SessionSupervisor.open(copiedPath, other)).rejects.toThrow();
		expect(other).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(supervisor!.session.waitState?.status).toBe("acknowledged"), { timeout: 3000 });
		supervisor.inbox.receive("signal:one", "synthetic inbox message");
		await expect(supervisor.dispatchOne()).resolves.toBe(true);
		expect(supervisor.session.getLastAssistantText()).toBe("inbox processed");
		expect((await supervisor.session.executionBudget!.snapshot()).modelRequests).toBe(2);
		await supervisor.close();
		supervisor = await SessionSupervisor.open(copiedPath, factory(harness, family));
		expect(supervisor.health().state).toBe("idle");
		expect(supervisor.inbox.receive("signal:one", "synthetic inbox message")).toBe("duplicate");
		await expect(supervisor.dispatchOne()).resolves.toBe(false);
		expect(supervisor.session.sessionId).toBe(sessionId);
		expect(readFileSync(path, "utf8")).toBe(readFileSync(copiedPath, "utf8"));
	} finally {
		await supervisor?.close();
		await harness.session.disposeAsync();
		harness.cleanup();
		rmSync(copyRoot, { recursive: true, force: true });
	}
});

it("refuses missing budget state and replaced identities before creating a session", async () => {
	const { harness, path } = await seed();
	try {
		await harness.session.disposeAsync();
		const anchor: SupervisorAnchor = JSON.parse(readFileSync(path, "utf8"));
		const budgetPath = join(harness.tempDir, anchor.budgetFile);
		const original = readFileSync(budgetPath, "utf8");
		const changed = { ...JSON.parse(original), id: "different-account" };
		writeFileSync(budgetPath, JSON.stringify(changed));
		writeFileSync(`${budgetPath}.identity`, JSON.stringify(changed.id));
		const create = vi.fn(factory(harness));
		await expect(SessionSupervisor.open(path, create)).rejects.toThrow("budget identity");
		rmSync(budgetPath);
		rmSync(`${budgetPath}.identity`);
		await expect(SessionSupervisor.open(path, create)).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
	} finally {
		harness.cleanup();
	}
});

it("pauses unfinished operations and distinguishes durable waiting from active no-progress", async () => {
	const { harness, path } = await seed();
	let supervisor: SessionSupervisor | undefined;
	try {
		await harness.session.agent.executionObserver!.beforeTool("unfinished", "external");
		await harness.session.disposeAsync();
		supervisor = await SessionSupervisor.open(path, factory(harness), 1000);
		expect(supervisor.health().state).toBe("needs_reconciliation");
		supervisor.inbox.receive("pending", "do not dispatch before reconciliation");
		await expect(supervisor.dispatchOne()).resolves.toBe(false);
		const issue = supervisor.session.recoveryIssues[0];
		supervisor.session.reconcileOperation(
			issue.id,
			"failed",
			"Synthetic fixture confirmed no external dispatch occurred",
		);
		supervisor.session.startWait(
			{ kind: "job", id: "job", generation: "one", deadline: Date.now() + 60_000 },
			"waiting for job",
		);
		expect(supervisor.health(Date.now() + 2000).state).toBe("waiting");
		supervisor.session.cancelWait();
		const streaming = vi.spyOn(supervisor.session, "isStreaming", "get").mockReturnValue(true);
		expect(supervisor.health(Date.now() + 2000).state).toBe("stalled");
		streaming.mockRestore();
	} finally {
		await supervisor?.close();
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});

it("refuses an uncertain or missing outbound journal before model startup", async () => {
	const { harness, path } = await seed();
	let supervisor: SessionSupervisor | undefined;
	try {
		await harness.session.disposeAsync();
		supervisor = await SessionSupervisor.open(path, factory(harness));
		await expect(
			supervisor.outbox.send("send-one", "synthetic payload", async () => {
				throw new Error("lost acknowledgment");
			}),
		).rejects.toThrow("lost acknowledgment");
		expect(supervisor.health().state).toBe("needs_reconciliation");
		await supervisor.close();
		supervisor = undefined;
		const create = vi.fn(factory(harness));
		await expect(SessionSupervisor.open(path, create)).rejects.toThrow("Outbound send outcome unknown");
		expect(create).not.toHaveBeenCalled();
		rmSync(join(harness.tempDir, "outbox", ".identity"));
		await expect(SessionSupervisor.open(path, create)).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
	} finally {
		await supervisor?.close();
		harness.cleanup();
	}
});
