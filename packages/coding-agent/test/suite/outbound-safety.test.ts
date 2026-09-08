import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { DurableOutbox } from "../../src/core/durable-outbox.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createSignalSendTool } from "../../src/core/signal-send.js";
import * as atomicFile from "../../src/utils/atomic-file.js";
import { createHarness } from "./harness.js";

it("deduplicates concurrent and restarted sends and rejects changed payloads", async () => {
	const harness = await createHarness();
	const directory = join(harness.tempDir, "outbox");
	let outbox = new DurableOutbox(directory);
	const send = vi.fn(async () => {});
	try {
		expect(await Promise.all([outbox.send("one", "payload", send), outbox.send("one", "payload", send)])).toEqual([
			"sent",
			"already_sent",
		]);
		expect(send).toHaveBeenCalledTimes(1);
		outbox.dispose();
		outbox = new DurableOutbox(directory);
		await expect(outbox.send("one", "payload", send)).resolves.toBe("already_sent");
		await expect(outbox.send("one", "changed", send)).rejects.toThrow("collision");
		expect(send).toHaveBeenCalledTimes(1);
	} finally {
		outbox.dispose();
		harness.cleanup();
	}
});

it("keeps uncertain sends blocked across restart and after an acknowledgment write failure", async () => {
	const harness = await createHarness();
	const directory = join(harness.tempDir, "outbox");
	let outbox = new DurableOutbox(directory);
	let sends = 0;
	try {
		const original = atomicFile.writeFileAtomicSync;
		const fault = vi.spyOn(atomicFile, "writeFileAtomicSync").mockImplementation((path, data, ...rest) => {
			if (String(data).includes('"status":"processed"')) throw new Error("synthetic completion write fault");
			return original(path, data, ...rest);
		});
		try {
			await expect(
				outbox.send("one", "payload", async () => {
					sends++;
				}),
			).rejects.toThrow("write fault");
		} finally {
			fault.mockRestore();
		}
		outbox.dispose();
		outbox = new DurableOutbox(directory);
		expect(outbox.issues).toMatchObject([{ id: "one", status: "unknown" }]);
		await expect(
			outbox.send("one", "payload", async () => {
				sends++;
			}),
		).rejects.toThrow("unknown");
		await expect(
			outbox.send("two", "another send", async () => {
				sends++;
			}),
		).rejects.toThrow("unknown");
		expect(sends).toBe(1);
		outbox.reconcile("one", "processed", "Synthetic server confirmed acknowledgment for the original send");
		await expect(
			outbox.send("one", "payload", async () => {
				sends++;
			}),
		).resolves.toBe("already_sent");
		expect(sends).toBe(1);
	} finally {
		outbox.dispose();
		harness.cleanup();
	}
});

it.each(["acknowledged", "wrong_id", "cancelled"] as const)(
	"runs the Signal adapter through the SDK with %s outcome",
	async (mode) => {
		const harness = await createHarness({ settings: { retry: { enabled: false }, compaction: { enabled: false } } });
		const outbox = new DurableOutbox(join(harness.tempDir, "outbox"));
		const tool = createSignalSendTool(
			{ url: "http://127.0.0.1:8088", account: "+15550000001", allowRecipients: ["+15550000002"] },
			outbox,
		);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
			const body = JSON.parse(String(options?.body));
			expect(body.params).toEqual({
				account: "+15550000001",
				recipient: ["+15550000002"],
				message: "synthetic message",
			});
			if (mode === "cancelled") return new Promise(() => {});
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: mode === "wrong_id" ? "wrong" : body.id,
					result: { timestamp: 1234 },
				}),
			);
		});
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions")),
			model: harness.getModel(),
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			customTools: [tool],
			noTools: "builtin",
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("signal_send", { recipient: "+15550000002", message: "synthetic message" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("observed send result"),
			]);
			const run = session.prompt("send fixture");
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
			if (mode === "cancelled") session.agent.abort();
			await run;
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(outbox.issues).toHaveLength(mode === "acknowledged" ? 0 : 1);
			if (mode !== "acknowledged") {
				expect(session.recoveryIssues.length).toBeGreaterThan(0);
				expect(harness.getPendingResponseCount()).toBe(1);
			}
		} finally {
			fetchMock.mockRestore();
			await session.disposeAsync();
			outbox.dispose();
			harness.cleanup();
		}
	},
);
