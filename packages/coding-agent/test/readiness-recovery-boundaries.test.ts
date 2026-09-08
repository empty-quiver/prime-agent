import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { completeWithProviderRetry } from "../src/core/provider-retry.js";

describe("independent recovery boundaries", () => {
	it.each(["before-publication", "after-publication"])("keeps complete JSON after SIGKILL %s", (phase) => {
		const dir = mkdtempSync(join(tmpdir(), "prime-candidate-crash-"));
		const path = join(dir, "state.json");
		const next = { generation: 2, payload: "abc".repeat(100000) };
		writeFileSync(path, JSON.stringify({ generation: 1 }));
		const moduleUrl = pathToFileURL(resolve("src/utils/atomic-file.ts")).href;
		const script = [
			`import { writeFileAtomicSync } from ${JSON.stringify(moduleUrl)};`,
			`const next = { generation: 2, payload: 'abc'.repeat(100000) };`,
			`writeFileAtomicSync(${JSON.stringify(path)}, JSON.stringify(next), { fsync: true, fsyncDir: true,
			 beforeRename: () => { if (${JSON.stringify(phase)} === 'before-publication') process.kill(process.pid, 'SIGKILL'); } });`,
			`process.kill(process.pid, 'SIGKILL');`,
		].join("\n");
		try {
			const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				encoding: "utf8",
				timeout: 15000,
			});
			expect(child.error).toBeUndefined();
			expect(child.signal, child.stderr).toBe("SIGKILL");
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(
				phase === "before-publication" ? { generation: 1 } : next,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		{ kind: "permission", expected: 1 },
		{ kind: "invalid_request", expected: 1 },
		{ kind: "auth", expected: 2 },
		{ kind: "server", expected: 4 },
		{ kind: "rate_limit", expected: 1, retryAfterMs: 3600000 },
	])("bounds attempts for $kind", async ({ kind, expected, retryAfterMs }) => {
		let attempts = 0;
		const result = await completeWithProviderRetry(
			async (): Promise<AssistantMessage> => {
				attempts++;
				return {
					role: "assistant",
					content: [],
					api: "openai-completions",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: "synthetic failure",
					timestamp: Date.now(),
					diagnostics: [
						{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind, retryAfterMs } },
					],
				};
			},
			{ policy: { enabled: true, maxRetries: 3, baseDelayMs: 1, maxRetryDelayMs: 100 } },
		);
		expect(attempts).toBe(expected);
		expect(result.stopReason).toBe("error");
	});
});
