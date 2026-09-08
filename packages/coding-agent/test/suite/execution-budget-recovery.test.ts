import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { ExecutionBudget } from "../../src/core/execution-budget.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../src/core/rlm-runtime.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { resolveRuntimeSessionOptions } from "../../src/main.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import * as atomicFile from "../../src/utils/atomic-file.js";
import { createHarness } from "./harness.js";

it.each(["runtime", "daemon"] as const)(
	"installs the shared budget before %s child startup can request a model",
	async (host) => {
		const harness = await createHarness({
			tools: [],
			persistSession: true,
			autonomous: { enabled: true, maxTurns: 1 },
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		const parent = harness.session;
		const children: AgentSession[] = [];
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: parent.modelRegistry,
			settingsManager: harness.settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true },
		});
		const factory: CreateAgentSessionRuntimeFactory = async (options) => {
			expect(options.sessionOptions?.executionBudget).toBe(parent.executionBudget);
			const resolved = resolveRuntimeSessionOptions({}, options.sessionOptions);
			const created = await createAgentSession({
				...resolved,
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				sessionManager: options.sessionManager,
				authStorage: harness.authStorage,
				modelRegistry: parent.modelRegistry,
				settingsManager: harness.settingsManager,
				resourceLoader: parent.resourceLoader,
				noTools: "all",
			});
			children.push(created.session);
			expect(created.session.executionBudget).toBe(parent.executionBudget);
			// Simulate a startup extension requesting work before onSessionPublished.
			await created.session.prompt("startup request");
			throw new Error("startup fixture complete");
		};
		const runtime = new AgentSessionRuntime(parent, services, factory);
		if (host === "daemon") {
			const daemon = new AgentDaemon(join(harness.tempDir, "test.sock"), {
				defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
				createRuntime: factory,
			});
			const create = Reflect.get(daemon, "createRlmSubagentRuntime") as (
				state: ActiveSessionState,
				options: CreateRlmSubagentRuntimeOptions,
			) => Promise<AgentSessionRuntime>;
			parent.setSubagentRuntimeHost({
				deleteRlmSubagentRuntime: async (_id, session) => {
					await session?.disposeAsync();
				},
				createRlmSubagentRuntime: (options) =>
					create.call(daemon, { activeSessionId: "test-parent", runtime } as ActiveSessionState, options),
			});
		}
		try {
			harness.setResponses([
				fauxAssistantMessage("startup consumed the allowance"),
				fauxAssistantMessage("must not execute"),
			]);
			const handle = await parent.runRlmChild("child work");
			await vi.waitFor(() => expect(parent.getRlmChildRunStatus(handle.rlm_child_id)).toBe("error"));
			expect(children).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(await parent.executionBudget?.snapshot()).toMatchObject({ modelRequests: 1 });
			await expect(
				parent.executionBudget!.beforeModel({ model: harness.getModel(), context: { messages: [] } }),
			).rejects.toThrow("model requests");
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			for (const child of children) await child.disposeAsync();
			await runtime.dispose();
			harness.cleanup();
		}
	},
);

it("rejects missing ledgers and changed identities instead of creating a new allowance", async () => {
	const harness = await createHarness({ tools: [] });
	const path = join(harness.tempDir, "budget.json");
	const budget = new ExecutionBudget({ maxToolCalls: 2 }, path);
	try {
		await budget.beforeTool("one", "fixture");
		const saved = readFileSync(path, "utf8");
		rmSync(path);
		await expect(budget.beforeTool("two", "fixture")).rejects.toThrow("ledger is missing");
		expect(() => new ExecutionBudget({}, path)).toThrow("ledger is missing");
		const changed = JSON.parse(saved);
		changed.id = "replacement";
		writeFileSync(path, JSON.stringify(changed));
		expect(() => new ExecutionBudget({}, path)).toThrow("identity changed");
	} finally {
		budget.dispose();
		harness.cleanup();
	}
});

it("fails closed on interrupted admission writes and preserves the last durable count", async () => {
	const harness = await createHarness({ tools: [] });
	const path = join(harness.tempDir, "budget.json");
	const budget = new ExecutionBudget({ maxToolCalls: 2 }, path);
	let resumed: ExecutionBudget | undefined;
	try {
		await budget.beforeTool("one", "fixture");
		const original = atomicFile.writeFileAtomicSync;
		const failing = vi.spyOn(atomicFile, "writeFileAtomicSync").mockImplementation((target, ...args) => {
			if (target === budget.path) throw new Error("synthetic disk failure");
			return original(target, ...args);
		});
		try {
			await expect(budget.beforeTool("two", "fixture")).rejects.toThrow("synthetic disk failure");
		} finally {
			failing.mockRestore();
		}
		expect(budget.signal.aborted).toBe(true);
		resumed = new ExecutionBudget({}, path);
		expect(await resumed.snapshot()).toMatchObject({ toolCalls: 1 });
		await resumed.beforeTool("two", "fixture");
		await expect(resumed.beforeTool("three", "fixture")).rejects.toThrow("tool calls");
	} finally {
		resumed?.dispose();
		budget.dispose();
		harness.cleanup();
	}
});

it("rejects deadline corruption and preserves a copied family's shared account", async () => {
	const harness = await createHarness({ tools: [], persistSession: true, autonomous: { enabled: true, maxTurns: 2 } });
	const copyRoot = mkdtempSync(join(tmpdir(), "prime-budget-family-copy-"));
	let reopened: AgentSession | undefined;
	let child: AgentSession | undefined;
	let copiedChild: AgentSession | undefined;
	try {
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		const sessionFile = harness.session.sessionFile!;
		const expected = await harness.session.executionBudget!.snapshot();
		const childManager = SessionManager.create(
			harness.tempDir,
			join(harness.sessionManager.getSessionArtifactDir()!, "child"),
		);
		childManager.newSession({ parentSession: sessionFile, rlmDepth: 1 });
		const common = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			noTools: "all" as const,
		};
		child = (
			await createAgentSession({
				...common,
				sessionManager: childManager,
				executionBudget: harness.session.executionBudget,
				model: harness.getModel(),
				rlmDepth: 1,
			})
		).session;
		child.setSessionName("copied-child");
		const childFile = child.sessionFile!;
		await child.disposeAsync();
		await harness.session.disposeAsync();
		const copied = join(copyRoot, "family");
		cpSync(harness.tempDir, copied, { recursive: true });
		const copiedFile = join(copied, relative(harness.tempDir, sessionFile));
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.open(copiedFile),
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			noTools: "all",
		});
		reopened = result.session;
		expect(await reopened.executionBudget?.snapshot()).toMatchObject({
			id: expected.id,
			modelRequests: expected.modelRequests,
		});
		copiedChild = (
			await createAgentSession({
				...common,
				sessionManager: SessionManager.open(join(copied, relative(harness.tempDir, childFile))),
				rlmDepth: 1,
			})
		).session;
		expect(copiedChild.executionBudget?.path).toBe(reopened.executionBudget?.path);
		expect(await copiedChild.executionBudget?.snapshot()).toMatchObject({
			id: expected.id,
			modelRequests: expected.modelRequests,
		});
		await copiedChild.disposeAsync();
		const path = reopened.executionBudget!.path!;
		const state = JSON.parse(readFileSync(path, "utf8"));
		state.deadline += 1000;
		writeFileSync(path, JSON.stringify(state));
		expect(() => new ExecutionBudget({}, path)).toThrow("Inconsistent execution budget");
	} finally {
		await copiedChild?.disposeAsync();
		await child?.disposeAsync();
		await reopened?.disposeAsync();
		harness.cleanup();
		rmSync(copyRoot, { recursive: true, force: true });
	}
});
