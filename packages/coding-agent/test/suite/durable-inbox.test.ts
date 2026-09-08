import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { DurableInbox } from "../../src/core/durable-inbox.js";
import * as atomicFile from "../../src/utils/atomic-file.js";
import { createHarness } from "./harness.js";

it("deduplicates across restart, rejects changed payloads, and dispatches through the session exactly once", async () => {
	const harness = await createHarness({ persistSession: true, tools: [], settings: { retry: { enabled: false } } });
	const directory = join(harness.tempDir, "inbox");
	let inbox = new DurableInbox(directory);
	try {
		expect(inbox.receive("signal:account:sender:1", "/new is untrusted message data")).toBe("accepted");
		expect(inbox.receive("signal:account:sender:1", "/new is untrusted message data")).toBe("duplicate");
		expect(() => inbox.receive("signal:account:sender:1", "changed")).toThrow("collision");
		expect(() => new DurableInbox(directory)).toThrow();
		harness.setResponses([fauxAssistantMessage("processed")]);
		const sessionId = harness.session.sessionId;
		await expect(
			inbox.dispatchNext((record) =>
				harness.session.promptAndWait(record.text!, {
					internalPrompt: true,
					agentMessageId: record.id,
					suppressAutonomousContinuation: true,
				}),
			),
		).resolves.toBe(true);
		expect(harness.session.sessionId).toBe(sessionId);
		expect(harness.session.getLastAssistantText()).toBe("processed");
		inbox.dispose();
		inbox = new DurableInbox(directory);
		expect(inbox.receive("signal:account:sender:1", "/new is untrusted message data")).toBe("duplicate");
		const deliver = vi.fn();
		await expect(inbox.dispatchNext(deliver)).resolves.toBe(false);
		expect(deliver).not.toHaveBeenCalled();
		const file = `${createHash("sha256").update("signal:account:sender:1").digest("hex")}.json`;
		expect(JSON.parse(readFileSync(join(directory, file), "utf8"))).not.toHaveProperty("text");
	} finally {
		inbox.dispose();
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});

it("persists dispatch before calling the adapter and recovers abrupt process exit as unknown", async () => {
	const harness = await createHarness({ tools: [] });
	const directory = join(harness.tempDir, "inbox");
	try {
		const source = new URL("../../src/core/durable-inbox.ts", import.meta.url).href;
		const script = `import { DurableInbox } from ${JSON.stringify(source)};
const inbox = new DurableInbox(process.argv[1]);
inbox.receive("crash", "private message");
await inbox.dispatchNext(async () => process.exit(17));`;
		await expect(
			promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], {
				timeout: 10_000,
			}),
		).rejects.toMatchObject({ code: 17 });
		const inbox = new DurableInbox(directory);
		try {
			expect(inbox.issues).toMatchObject([{ id: "crash", status: "unknown" }]);
			expect(inbox.receive("crash", "private message")).toBe("duplicate");
			await expect(inbox.dispatchNext(vi.fn())).rejects.toThrow("unknown");
			expect(() => inbox.reconcile("crash", "received", "")).toThrow("evidence");
			inbox.reconcile("crash", "processed", "Fixture confirmed dispatch occurred before process exit");
			await expect(inbox.dispatchNext(vi.fn())).resolves.toBe(false);
		} finally {
			inbox.dispose();
		}
	} finally {
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});

it("does not dispatch after a failed durable claim and quarantines adapter failures", async () => {
	const harness = await createHarness({ tools: [] });
	const directory = join(harness.tempDir, "inbox");
	let inbox = new DurableInbox(directory);
	try {
		inbox.receive("one", "message");
		const fault = vi.spyOn(atomicFile, "writeFileAtomicSync").mockImplementationOnce(() => {
			throw new Error("disk failure");
		});
		const deliver = vi.fn();
		try {
			await expect(inbox.dispatchNext(deliver)).rejects.toThrow("disk failure");
		} finally {
			fault.mockRestore();
		}
		expect(deliver).not.toHaveBeenCalled();
		inbox.dispose();
		inbox = new DurableInbox(directory);
		await expect(
			inbox.dispatchNext(async () => {
				throw new Error("delivery failed");
			}),
		).rejects.toThrow("delivery failed");
		expect(inbox.issues).toHaveLength(1);
		await expect(inbox.dispatchNext(deliver)).rejects.toThrow("unknown");
	} finally {
		inbox.dispose();
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});
