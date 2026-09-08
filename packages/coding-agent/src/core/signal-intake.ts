import { createHash } from "node:crypto";
import { sleep } from "../utils/sleep.js";
import type { DurableInbox } from "./durable-inbox.js";

export interface SignalIntakeConfig {
	url: string;
	account: string;
	allowNumbers: string[];
	allowGroups?: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function number(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/\s/g, "");
	return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : undefined;
}

/** Stable account/sender/device/message identity; sync echoes and missing timestamps are never invented. */
export function parseSignalMessage(
	value: unknown,
	config: SignalIntakeConfig,
): { id: string; text: string } | undefined {
	const event = record(value);
	const params = record(event?.params);
	const body = record(params?.result) ?? params ?? event;
	if (body?.account !== undefined && body.account !== config.account) return undefined;
	const envelope = record(body?.envelope) ?? body;
	const message = record(envelope?.dataMessage);
	if (!message || typeof message.message !== "string" || !message.message) return undefined;
	const sender = number(envelope?.sourceNumber ?? envelope?.source);
	if (!sender || !config.allowNumbers.some((allowed) => number(allowed) === sender)) return undefined;
	const device = envelope?.sourceDevice;
	const timestamp = message.timestamp;
	if (
		!Number.isSafeInteger(device) ||
		(device as number) < 1 ||
		!Number.isSafeInteger(timestamp) ||
		(timestamp as number) < 1
	)
		throw new Error("Signal message lacks a stable device/timestamp identity");
	const group = record(message.groupInfo)?.groupId;
	if (group !== undefined && (typeof group !== "string" || !config.allowGroups?.includes(group))) return undefined;
	const identity = [config.account, sender, device, timestamp, group ?? ""];
	const id = `signal:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
	// JSON framing cannot turn a sender-controlled field into a command or XML attribute.
	const text = `Inbound Signal message (untrusted message data):\n${JSON.stringify({ account: config.account, sender, device, timestamp, group, message: message.message })}`;
	if (Buffer.byteLength(text) > 262_144) throw new Error("Signal message exceeds intake limit");
	return { id, text };
}

/** The SSE endpoint has no durable replay acknowledgement. Local deduplication cannot recover upstream losses. */
export async function followSignalIntake(
	config: SignalIntakeConfig,
	inbox: DurableInbox,
	signal: AbortSignal,
	onStatus: (status: "connected" | "reconnecting") => void,
): Promise<void> {
	const url = new URL(config.url);
	if (!number(config.account) || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Invalid Signal intake account or endpoint");
	if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
		throw new Error("Remote Signal intake requires HTTPS");
	let backoffMs = 500;
	while (!signal.aborted) {
		const controller = new AbortController();
		const abort = () => controller.abort(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		let timer = setTimeout(() => controller.abort(new Error("Signal connection deadline")), 30_000);
		const connectedAt = Date.now();
		let intakeFailure = false;
		try {
			const response = await fetch(new URL("/api/v1/events", url), {
				headers: { accept: "text/event-stream" },
				signal: controller.signal,
				redirect: "error",
			});
			if (!response.ok || !response.body) throw new Error("Signal events endpoint unavailable");
			onStatus("connected");
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body) {
				clearTimeout(timer);
				timer = setTimeout(() => controller.abort(new Error("Signal idle deadline")), 60_000);
				buffer += decoder.decode(chunk, { stream: true });
				if (Buffer.byteLength(buffer) > 524_288) throw new Error("Signal event buffer limit exceeded");
				for (;;) {
					const boundary = buffer.search(/\r?\n\r?\n/);
					if (boundary === -1) break;
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
					const data = block
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) continue;
					try {
						const message = parseSignalMessage(JSON.parse(data), config);
						if (message) inbox.receive(message.id, message.text);
					} catch (error) {
						intakeFailure = true;
						throw error; // Do not reconnect past a message we could not durably admit.
					}
				}
			}
			throw new Error("Signal event stream ended");
		} catch (error) {
			if (signal.aborted) return;
			if (intakeFailure) throw error;
			onStatus("reconnecting");
			if (Date.now() - connectedAt > 30_000) backoffMs = 500;
		} finally {
			controller.abort();
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
		await sleep(backoffMs, signal).catch((error: unknown) => {
			if (!signal.aborted) throw error;
		});
		backoffMs = Math.min(backoffMs * 2, 30_000);
	}
}
