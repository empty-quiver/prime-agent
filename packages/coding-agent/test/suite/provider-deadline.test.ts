import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { ExecutionBudget } from "../../src/core/execution-budget.js";
import type { RlmChildFailureDetails } from "../../src/core/messages.js";
import { completeWithProviderRetry, providerStreamFailureKind } from "../../src/core/provider-retry.js";
import { startSideQuestion } from "../../src/core/side-question.js";
import { createHarness } from "./harness.js";

it("bounds an uncooperative provider and does not automatically retry an unknown outcome", async () => {
	const harness = await createHarness();
	let attempts = 0;
	let providerSignal: AbortSignal | undefined;
	try {
		harness.session.agent.providerTimeoutMs = 20;
		harness.session.agent.streamFn = (_model, _context, options) => {
			attempts++;
			providerSignal = options?.signal;
			return new Promise(() => {});
		};
		await harness.session.prompt("Make one request");
		await harness.session.agent.waitForIdle();
		const terminal = harness.session.messages.at(-1) as AssistantMessage;
		expect(terminal.stopReason).toBe("error");
		expect(providerStreamFailureKind(terminal)).toBe("timeout");
		expect(terminal.errorMessage).toContain("exceeded 20 ms");
		expect(providerSignal?.aborted).toBe(true);
		expect(attempts).toBe(1);
	} finally {
		harness.cleanup();
	}
});

it("bounds credential lookup before contacting a provider", async () => {
	const harness = await createHarness();
	try {
		harness.session.agent.providerTimeoutMs = 20;
		harness.session.agent.getApiKey = () => new Promise(() => {});
		await harness.session.prompt("Hello");
		expect(providerStreamFailureKind(harness.session.messages.at(-1) as AssistantMessage)).toBe("timeout");
	} finally {
		harness.cleanup();
	}
});

it("cancels and bounds an auxiliary request even without an execution budget", async () => {
	let signal: AbortSignal | undefined;
	await expect(
		completeWithProviderRetry(
			(requestSignal) => {
				signal = requestSignal;
				return new Promise(() => {});
			},
			{ providerTimeoutMs: 20 },
		),
	).rejects.toMatchObject({ kind: "timeout", retrySafe: false });
	expect(signal?.aborted).toBe(true);
});

it("does not report a failed child assistant response as successful completion", async () => {
	const harness = await createHarness({
		persistSession: true,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	try {
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic provider failure" }),
		]);
		const handle = await harness.session.runRlmChild("fail this request");
		await vi.waitFor(async () => {
			expect(
				(await harness.session.listRlmSubagents()).subagents.find(
					(child) => child.rlm_child_id === handle.rlm_child_id,
				)?.status,
			).toBe("error");
		});
		expect(harness.eventsOfType("rlm_child_update").some((event) => event.child.status === "done")).toBe(false);
	} finally {
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});

it("charges side questions against the parent's host budget", async () => {
	const harness = await createHarness();
	const budget = new ExecutionBudget({ maxModelRequests: 1 });
	harness.session.agent.executionGovernor = budget;
	try {
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not be requested")]);
		await startSideQuestion(harness.session.agent, "one", "first", () => {}).done;
		await startSideQuestion(harness.session.agent, "two", "second", () => {}).done;
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(await budget.snapshot()).toMatchObject({ modelRequests: 1, exhausted: "model requests" });
	} finally {
		budget.dispose();
		harness.cleanup();
	}
});

it.each(["timeout", "worker_crash", "provider_failure"] as const)(
	"retains a structured %s child outcome without authorizing repetition",
	async (kind) => {
		const harness = await createHarness({
			persistSession: true,
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
		});
		try {
			const response = fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic failure" });
			response.diagnostics = [
				{
					type: kind === "worker_crash" ? "agent_lifecycle_failure" : "provider_stream_failure",
					timestamp: Date.now(),
					details: { kind },
				},
			];
			harness.setResponses([response]);
			await harness.session.runRlmChild("classified failure");
			await vi.waitFor(() => {
				const message = harness.session.messages.find(
					(entry) => entry.role === "custom" && entry.customType === "rlm_child_failure",
				);
				expect(message?.role).toBe("custom");
				if (message?.role === "custom")
					expect((message.details as RlmChildFailureDetails).failure).toEqual({
						kind,
						outcome: kind === "provider_failure" ? "failed" : "unknown",
						retrySafe: false,
					});
			});
		} finally {
			await harness.session.disposeAsync();
			harness.cleanup();
		}
	},
);
