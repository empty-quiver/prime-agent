import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { DurableWait } from "../../src/core/durable-wait.js";
import { createHarness, type Harness } from "./harness.js";

it("ends an endless tool turn and wakes exactly once when the durable deadline expires", async () => {
	let harness: Harness;
	let toolCalls = 0;
	const tool: AgentTool = {
		name: "wait",
		label: "wait",
		description: "durably wait",
		parameters: Type.Object({}),
		execute: async () => {
			toolCalls++;
			harness.session.startWait({ kind: "deadline", deadline: Date.now() + 150 }, "test deadline");
			return { content: [], details: {} };
		},
	};
	harness = await createHarness({
		tools: [tool],
		persistSession: true,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("awake"),
		]);
		await harness.session.prompt("wait");
		expect(toolCalls).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.waitState?.status).toBe("pending");
		await vi.waitFor(() => expect(harness.session.waitState?.status).toBe("acknowledged"));
		expect(harness.session.getLastAssistantText()).toBe("awake");
		expect(
			harness.session.messages.filter((m) => m.role === "custom" && m.customType === "durable_wait"),
		).toHaveLength(1);
	} finally {
		harness.cleanup();
	}
});

it("restores pending waits but does not replay a delivery interrupted by a process restart", async () => {
	const harness = await createHarness();
	const path = join(harness.tempDir, "wait.json");
	let ready = 0;
	const first = new DurableWait(path, () => ready++);
	first.start({ kind: "deadline", deadline: Date.now() + 100 }, "recover");
	first.dispose();
	const restored = new DurableWait(path, () => ready++);
	try {
		restored.resume();
		expect(restored.paused).toBe(true);
		await vi.waitFor(() => expect(ready).toBe(1));
		expect(restored.claim()?.status).toBe("delivering");
		restored.dispose();
		const crashed = new DurableWait(path, () => ready++);
		try {
			crashed.resume();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(ready).toBe(1);
			expect(crashed.paused).toBe(true);
			expect(crashed.claim()).toBeUndefined();
			crashed.cancel();
			expect(crashed.paused).toBe(false);
		} finally {
			crashed.dispose();
		}
	} finally {
		restored.dispose();
		harness.cleanup();
	}
});

it("rejects stale completion generations and duplicate job notifications", async () => {
	const harness = await createHarness();
	let ready = 0;
	const wait = new DurableWait(join(harness.tempDir, "wait.json"), () => ready++);
	try {
		const state = wait.start(
			{ kind: "job", id: "job", generation: "new", deadline: Date.now() + 60_000 },
			"job completion",
		);
		await Promise.resolve();
		expect(wait.notify(state.id, "job", "job", "old", "completed")).toBe(false);
		expect(wait.notify(state.id, "job", "job", "new", "failed")).toBe(true);
		for (let i = 0; i < 1000; i++) expect(wait.notify(state.id, "job", "job", "new", "completed")).toBe(false);
		expect(ready).toBe(1);
		expect(wait.claim()).toMatchObject({ outcome: "failed", status: "delivering" });
		wait.acknowledge(state.id);
		expect(wait.paused).toBe(false);
	} finally {
		wait.dispose();
		harness.cleanup();
	}
});

it("cancels disposed wait callbacks and bounds missing job reports by a deadline", async () => {
	const wait = new DurableWait(undefined, () => {});
	wait.start({ kind: "job", id: "job", generation: "one", deadline: Date.now() + 20 }, "missing report");
	await vi.waitFor(() => expect(wait.snapshot()).toMatchObject({ status: "ready", outcome: "timeout" }));
	wait.dispose();
	expect(() => wait.claim()).toThrow("disposed");
});

it("rejects a second persisted owner and permits acquisition after confirmed release", async () => {
	const harness = await createHarness();
	const path = join(harness.tempDir, "wait.json");
	const first = new DurableWait(path, () => {});
	try {
		expect(() => new DurableWait(path, () => {})).toThrow("already active");
		first.dispose();
		const next = new DurableWait(path, () => {});
		next.dispose();
	} finally {
		first.dispose();
		harness.cleanup();
	}
});

it("allows a wake to install a new wait without acknowledging or replaying that new generation", async () => {
	const wait = new DurableWait(undefined, () => {});
	try {
		const first = wait.start({ kind: "deadline", deadline: 0 }, "first");
		wait.claim();
		const second = wait.start({ kind: "deadline", deadline: Date.now() + 60_000 }, "next");
		wait.acknowledge(first.id);
		expect(wait.snapshot()).toMatchObject({ id: second.id, status: "pending" });
		expect(wait.paused).toBe(true);
	} finally {
		wait.dispose();
	}
});
