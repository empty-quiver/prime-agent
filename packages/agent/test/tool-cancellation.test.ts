import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.js";
import { joinCancelledTool, validateCancellationGrace } from "../src/tool-cancellation.js";
import type { AgentEvent, AgentTool } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function runFixture(execute: AgentTool["execute"], grace = 1000, failReceipt = false) {
	const controller = new AbortController();
	const events: AgentEvent[] = [];
	const outcomes: string[] = [];
	const afterToolCall = vi.fn();
	const run = runAgentLoop(
		[{ role: "user", content: "fixture", timestamp: 0 }],
		{
			systemPrompt: "",
			messages: [],
			tools: [
				{
					name: "work",
					label: "work",
					description: "work",
					parameters: Type.Object({}),
					cancellationGraceMs: grace,
					execute,
				},
			],
		},
		{
			model,
			convertToLlm: (messages) => messages as Message[],
			afterToolCall,
			executionObserver: {
				beforeModel: async () => {},
				beforeTool: async () => ({
					settle: async (outcome) => {
						outcomes.push(outcome);
						if (failReceipt) throw new Error("receipt write failed");
					},
				}),
			},
		},
		(event) => {
			events.push(event);
		},
		controller.signal,
		() => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("unexpected event");
				},
			);
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "work-1", name: "work", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
				timestamp: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { ...model.cost, total: 0 },
				},
			};
			queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
			return stream;
		},
	);
	return { run, controller, events, outcomes, afterToolCall };
}

describe("bounded tool cancellation join", () => {
	it.each([false, true])("joins cleanup even when recording the unknown receipt fails: %s", async (failReceipt) => {
		let started!: () => void;
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finish!: () => void;
		const finishing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let cleanupFinished = false;
		const fixture = runFixture(
			async () => {
				started();
				await finishing;
				cleanupFinished = true;
				return { content: [], details: {} };
			},
			1000,
			failReceipt,
		);
		let returned = false;
		const completion = fixture.run.then(
			() => {
				returned = true;
			},
			(error: unknown) => {
				returned = true;
				return error;
			},
		);
		await starting;
		fixture.controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fixture.outcomes).toEqual(["unknown"]);
		expect(returned).toBe(false);
		finish();
		const error = await completion;
		expect(cleanupFinished).toBe(true);
		if (failReceipt) expect(error).toEqual(new Error("receipt write failed"));
		else {
			const result = fixture.events.find((event) => event.type === "tool_execution_end");
			expect(result?.type === "tool_execution_end" && result.result.details).toEqual({
				status: "aborted",
				outcome: "unknown",
				cleanup: "settled",
			});
		}
		expect(fixture.afterToolCall).not.toHaveBeenCalled();
	});

	it("bounds an uncooperative tool and contains its later rejection", async () => {
		let started!: () => void;
		const starting = new Promise<void>((resolve) => {
			started = resolve;
		});
		let reject!: (error: Error) => void;
		const fixture = runFixture(() => {
			started();
			return new Promise((_resolve, rejectOperation) => {
				reject = rejectOperation;
			});
		}, 20);
		await starting;
		fixture.controller.abort();
		await fixture.run;
		const result = fixture.events.find((event) => event.type === "tool_execution_end");
		expect(result?.type === "tool_execution_end" && result.result.details).toEqual({
			status: "aborted",
			outcome: "unknown",
			cleanup: "unconfirmed",
		});
		reject(new Error("late cleanup failure"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fixture.outcomes).toEqual(["unknown"]);
	});

	it("classifies a cleanup rejection and rejects invalid grace periods", async () => {
		await expect(joinCancelledTool(Promise.reject(new Error("exit unconfirmed")), 100)).resolves.toEqual({
			status: "failed",
			error: "exit unconfirmed",
		});
		for (const value of [NaN, Infinity, -1, 0.5, 30_001])
			expect(() => validateCancellationGrace(value)).toThrow("cancellationGraceMs");
		expect(validateCancellationGrace()).toBe(0);
		expect(validateCancellationGrace(30_000)).toBe(30_000);
	});
});
