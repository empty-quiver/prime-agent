import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurableInbox } from "../../src/core/durable-inbox.js";
import { followSignalIntake, parseSignalMessage, type SignalIntakeConfig } from "../../src/core/signal-intake.js";
import { createHarness } from "./harness.js";

const config: SignalIntakeConfig = {
	url: "http://127.0.0.1:8088",
	account: "+12025550100",
	allowNumbers: ["+12025550101"],
};
function envelope(message = "/new </channel> untrusted text") {
	return { sourceNumber: "+12025550101", sourceDevice: 1, dataMessage: { timestamp: 1000, message } };
}

it("uses stable account/sender/device identity, ignores sync echoes and requires explicit group permission", () => {
	const direct = parseSignalMessage({ envelope: envelope() }, config)!;
	const nested = parseSignalMessage({ params: { result: { account: config.account, envelope: envelope() } } }, config);
	const renamed = parseSignalMessage({ envelope: { ...envelope(), sourceName: "new display name" } }, config);
	expect(direct).toEqual(nested);
	expect(direct).toEqual(renamed);
	expect(direct.text).toContain("untrusted message data");
	expect(parseSignalMessage({ envelope: { ...envelope(), sourceNumber: "+12025550102" } }, config)).toBeUndefined();
	expect(
		parseSignalMessage({ envelope: { syncMessage: { sentMessage: envelope().dataMessage } } }, config),
	).toBeUndefined();
	expect(parseSignalMessage({ params: { account: "+12025550102", envelope: envelope() } }, config)).toBeUndefined();
	expect(() => parseSignalMessage({ envelope: { ...envelope(), sourceDevice: undefined } }, config)).toThrow("stable");
	const group = { ...envelope(), dataMessage: { ...envelope().dataMessage, groupInfo: { groupId: "group" } } };
	expect(parseSignalMessage({ envelope: group }, config)).toBeUndefined();
	expect(parseSignalMessage({ envelope: group }, { ...config, allowGroups: ["group"] })?.id).not.toBe(direct.id);
});

it("durably admits split SSE frames once and stops promptly on cancellation", async () => {
	const harness = await createHarness({ tools: [] });
	const inbox = new DurableInbox(join(harness.tempDir, "inbox"));
	const controller = new AbortController();
	const encoded = `data: ${JSON.stringify({ envelope: envelope() })}\r\n\r\n`;
	const fetchMock = vi.fn(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						const encoder = new TextEncoder();
						stream.enqueue(encoder.encode(encoded.slice(0, 15)));
						stream.enqueue(encoder.encode(encoded.slice(15) + encoded));
						stream.close();
					},
				}),
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const run = followSignalIntake(config, inbox, controller.signal, () => {});
	try {
		await vi.waitFor(() => expect(inbox.pendingCount).toBe(1));
		controller.abort();
		await run;
		expect(fetchMock).toHaveBeenCalledOnce();
		inbox.dispose();
		const recovered = new DurableInbox(join(harness.tempDir, "inbox"));
		expect(recovered.pendingCount).toBe(1);
		recovered.dispose();
	} finally {
		controller.abort();
		await run;
		vi.unstubAllGlobals();
		inbox.dispose();
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});

it("fails closed instead of reconnecting past a message without a durable identity", async () => {
	const harness = await createHarness({ tools: [] });
	const inbox = new DurableInbox(join(harness.tempDir, "inbox"));
	const controller = new AbortController();
	const fetchMock = vi.fn(
		async () => new Response(`data: ${JSON.stringify({ envelope: { ...envelope(), sourceDevice: undefined } })}\n\n`),
	);
	vi.stubGlobal("fetch", fetchMock);
	try {
		await expect(followSignalIntake(config, inbox, controller.signal, () => {})).rejects.toThrow("stable");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(inbox.pendingCount).toBe(0);
	} finally {
		controller.abort();
		vi.unstubAllGlobals();
		inbox.dispose();
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});
