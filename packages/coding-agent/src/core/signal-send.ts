import { createRequestDeadline } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { waitWithAbort } from "../utils/wait-with-abort.js";
import type { DurableOutbox } from "./durable-outbox.js";
import type { ToolDefinition } from "./extensions/index.js";

export interface SignalSendConfig {
	url: string;
	account: string;
	allowRecipients: string[];
}

async function readReply(response: Response): Promise<unknown> {
	if (!response.ok || !response.body) throw new Error("Signal send response was not successful; outcome unknown");
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		if (size > 65_536) throw new Error("Signal send response exceeded its limit; outcome unknown");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createSignalSendTool(config: SignalSendConfig, outbox: DurableOutbox): ToolDefinition {
	const url = new URL(config.url);
	if (
		!/^\+[1-9]\d{6,14}$/.test(config.account) ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		(url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ||
		!Array.isArray(config.allowRecipients) ||
		!config.allowRecipients.length ||
		config.allowRecipients.some((value) => !/^\+[1-9]\d{6,14}$/.test(value))
	)
		throw new Error("Invalid Signal outbound configuration");
	return {
		name: "signal_send",
		label: "Signal send",
		description:
			"Send an authorized Signal message to an explicitly allowed recipient. Unknown outcomes require operator reconciliation; never repeat an uncertain send.",
		parameters: Type.Object({ recipient: Type.String(), message: Type.String({ minLength: 1, maxLength: 16_384 }) }),
		cancellationGraceMs: 2000,
		execute: async (toolCallId, args, signal) => {
			const { recipient, message } = args as { recipient: string; message: string };
			if (
				!config.allowRecipients.includes(recipient) ||
				typeof message !== "string" ||
				!message ||
				Buffer.byteLength(message) > 65_536
			)
				throw new Error("Signal recipient or message is not allowed");
			const params = { account: config.account, recipient: [recipient], message };
			const result = await outbox.send(
				toolCallId,
				JSON.stringify(params),
				async () => {
					const deadline = createRequestDeadline(signal, 30_000);
					try {
						// JSON-RPC id correlates the response; signal-cli does not promise idempotency for it.
						const reply = await waitWithAbort(
							fetch(new URL("/api/v1/rpc", url), {
								method: "POST",
								headers: { "content-type": "application/json" },
								redirect: "error",
								signal: deadline.signal,
								body: JSON.stringify({ jsonrpc: "2.0", id: toolCallId, method: "send", params }),
							}).then(readReply),
							deadline.signal,
						);
						if (!reply || typeof reply !== "object")
							throw new Error("Invalid Signal send acknowledgment; outcome unknown");
						const response = reply as {
							jsonrpc?: string;
							id?: unknown;
							result?: { timestamp?: unknown };
							error?: unknown;
						};
						if (
							response.jsonrpc !== "2.0" ||
							response.id !== toolCallId ||
							response.error !== undefined ||
							!Number.isSafeInteger(response.result?.timestamp)
						)
							throw new Error("Signal send was not acknowledged; outcome unknown, do not automatically resend");
					} finally {
						deadline.dispose();
					}
				},
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text:
							result === "sent"
								? "Signal server acknowledged the send."
								: "This send was already acknowledged; it was not sent again.",
					},
				],
				details: { status: result },
			};
		},
	};
}
