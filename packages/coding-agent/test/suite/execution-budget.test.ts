import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionBudget } from "../../src/core/execution-budget.js";
import { completeWithProviderRetry } from "../../src/core/provider-retry.js";
import { createHarness, type Harness } from "./harness.js";

describe("host execution budgets", () => {
	const harnesses: Harness[] = [];
	const budgets: ExecutionBudget[] = [];
	const executeFile = promisify(execFile);
	afterEach(() => {
		for (const budget of budgets.splice(0)) budget.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("admits only two model requests even when every response requests another tool", async () => {
		let toolCalls = 0;
		const tool: AgentTool = {
			name: "repeat",
			label: "repeat",
			description: "repeat",
			parameters: Type.Object({}),
			execute: async () => {
				toolCalls++;
				return { content: [], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [tool],
			settings: { compaction: { enabled: false } },
			models: [{ id: "small", contextWindow: 1000, maxTokens: 1000 }],
			autonomous: { enabled: true, maxTurns: 2 },
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 10 }, () => fauxAssistantMessage(fauxToolCall("repeat", {}), { stopReason: "toolUse" })),
		);
		await harness.session.prompt("repeat forever");
		expect(toolCalls).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(8);
		expect(await harness.session.executionBudget?.snapshot()).toMatchObject({
			modelRequests: 2,
			toolCalls: 2,
			exhausted: "model requests",
		});
	});

	it("accounts parallel tool admission separately from model turns", async () => {
		let calls = 0;
		const tool: AgentTool = {
			name: "repeat",
			label: "repeat",
			description: "repeat",
			parameters: Type.Object({}),
			execute: async () => {
				calls++;
				return { content: [], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		const budget = new ExecutionBudget({ maxToolCalls: 2 });
		budgets.push(budget);
		harness.session.agent.executionGovernor = budget;
		harness.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 5 }, () => fauxToolCall("repeat", {})),
				{ stopReason: "toolUse" },
			),
		]);
		await harness.session.prompt("parallel calls");
		expect(calls).toBeLessThanOrEqual(2);
		expect(await budget.snapshot()).toMatchObject({ toolCalls: 2, exhausted: "tool calls" });
	});

	it("retains reservations and exhaustion across reopen with larger requested limits", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const path = join(harness.tempDir, "budget.json");
		const first = new ExecutionBudget({ maxModelRequests: 1 }, path);
		budgets.push(first);
		await first.beforeModel({ model: harness.getModel(), context: { messages: [] } });
		const resumed = new ExecutionBudget({ maxModelRequests: 100 }, path);
		budgets.push(resumed);
		await expect(resumed.beforeModel({ model: harness.getModel(), context: { messages: [] } })).rejects.toThrow(
			"model requests",
		);
		expect(Object.keys((await resumed.snapshot()).pending)).toHaveLength(1);
		const restarted = new ExecutionBudget({}, path);
		budgets.push(restarted);
		expect(restarted.signal.aborted).toBe(true);
	});

	it("reserves token and cost allowance across independent concurrent owners", async () => {
		const harness = await createHarness({ tools: [], models: [{ id: "small", contextWindow: 100, maxTokens: 20 }] });
		harnesses.push(harness);
		const path = join(harness.tempDir, "budget.json");
		const limits = { maxTokens: 240, maxCost: 2, maxCostPerModelRequest: 1 };
		const owners = Array.from({ length: 3 }, () => new ExecutionBudget(limits, path));
		budgets.push(...owners);
		const results = await Promise.allSettled(
			owners.map((owner) => owner.beforeModel({ model: harness.getModel(), context: { messages: [] } })),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		const state = await owners[0].snapshot();
		expect(state.modelRequests).toBe(2);
		expect(Object.values(state.pending).reduce((sum, entry) => sum + entry.cost, 0)).toBe(2);
	});

	it("reconciles successful usage exactly once and preserves unknown outcomes", async () => {
		const harness = await createHarness({ tools: [], models: [{ id: "small", contextWindow: 100, maxTokens: 20 }] });
		harnesses.push(harness);
		const budget = new ExecutionBudget({ maxTokens: 240 });
		budgets.push(budget);
		const request = { model: harness.getModel(), context: { messages: [] } };
		const known = await budget.beforeModel(request);
		const unknown = await budget.beforeModel(request);
		const message = fauxAssistantMessage("ok");
		message.usage = { ...message.usage, input: 20, output: 10, totalTokens: 30 };
		await known.settle(message);
		await known.settle(message);
		await unknown.settle();
		const state = await budget.snapshot();
		expect(state.tokens).toBe(30);
		expect(Object.values(state.pending)).toEqual([{ tokens: 120, cost: 0 }]);
	});

	it("cancels a provider that never responds when its deadline expires", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const budget = new ExecutionBudget({ timeoutMs: 100 });
		budgets.push(budget);
		harness.session.agent.executionGovernor = budget;
		harness.setResponses([() => new Promise(() => {})]);
		await harness.session.prompt("never resolve");
		expect(harness.session.isStreaming).toBe(false);
		expect(await budget.snapshot()).toMatchObject({ exhausted: "deadline", modelRequests: 1 });
	});

	it("charges every auxiliary retry to the same account", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const budget = new ExecutionBudget({ maxModelRequests: 2 });
		budgets.push(budget);
		let attempts = 0;
		await expect(
			completeWithProviderRetry(
				async () => {
					attempts++;
					return fauxAssistantMessage("failure", { stopReason: "error", errorMessage: "transient failure" });
				},
				{
					policy: {
						enabled: true,
						maxRetries: 100,
						baseDelayMs: 0,
						maxRetryDelayMs: 0,
						execution: { governor: budget, model: harness.getModel() },
					},
				},
			),
		).rejects.toThrow("model requests");
		expect(attempts).toBe(2);
		expect(await budget.snapshot()).toMatchObject({ modelRequests: 2 });
	});

	it("bounds an abort-insensitive auxiliary provider wait", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const budget = new ExecutionBudget({ timeoutMs: 50 });
		budgets.push(budget);
		await expect(
			completeWithProviderRetry(() => new Promise(() => {}), {
				policy: {
					enabled: false,
					maxRetries: 0,
					baseDelayMs: 0,
					maxRetryDelayMs: 0,
					execution: { governor: budget, model: harness.getModel() },
				},
			}),
		).rejects.toThrow("deadline");
	});

	it("enforces one durable allowance across separate OS processes", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const path = join(harness.tempDir, "cross-process-budget.json");
		const source = new URL("../../src/core/execution-budget.ts", import.meta.url).href;
		const script = `import { ExecutionBudget } from ${JSON.stringify(source)};
const budget = new ExecutionBudget({ maxToolCalls: 10 }, process.argv[1]);
const results = await Promise.allSettled(Array.from({ length: 10 }, () => budget.beforeTool("test", "test")));
process.stdout.write(String(results.filter(result => result.status === "fulfilled").length));
budget.dispose();`;
		const results = await Promise.all(
			Array.from({ length: 3 }, () =>
				executeFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path], {
					timeout: 10_000,
				}),
			),
		);
		expect(results.reduce((sum, result) => sum + Number(result.stdout), 0)).toBe(10);
		const reopened = new ExecutionBudget({}, path);
		budgets.push(reopened);
		expect(await reopened.snapshot()).toMatchObject({ toolCalls: 10, exhausted: "tool calls" });
	});

	it("shares admission with delegated children without double-charging attributed usage", async () => {
		let harness: Harness;
		const tool: AgentTool = {
			name: "delegate",
			label: "delegate",
			description: "delegate",
			parameters: Type.Object({}),
			execute: async () => {
				const handle = await harness.session.runRlmChild("child task");
				await vi.waitFor(() => {
					const child = harness.session.getRlmChildSession(handle.rlm_child_id);
					expect(child?.getLastAssistantText()).toBe("child completed");
				});
				return { content: [], details: {} };
			},
		};
		harness = await createHarness({
			tools: [tool],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			autonomous: { enabled: true, maxTurns: 2 },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("child completed"),
			fauxAssistantMessage("forbidden third request"),
		]);
		await harness.session.prompt("delegate work");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(await harness.session.executionBudget?.snapshot()).toMatchObject({
			modelRequests: 2,
			exhausted: "model requests",
		});
		await harness.session.disposeAsync();
	});
});
