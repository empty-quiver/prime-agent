import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCopiedSessionCanary } from "./copied-session-canary.js";
import { createHarness } from "./harness.js";

it.skipIf(!process.env.PRIME_AGENT_TEST_PINNED_PYTHON)(
	"completes two real-kernel copied-session canary cycles with no remote provider",
	async () => {
		const harness = await createHarness({ persistSession: true });
		try {
			harness.session.setSessionName("canary seed");
			const source = harness.session.sessionFile!;
			const id = harness.session.sessionId;
			await harness.session.disposeAsync();
			const root = join(harness.tempDir, "copied");
			mkdirSync(join(root, "sessions"), { recursive: true });
			const file = join(root, "sessions", basename(source));
			copyFileSync(source, file);
			for (const name of [
				"PRIME_AGENT_KERNEL_PYTHON",
				"PRIME_AGENT_KERNEL_MANIFEST",
				"PRIME_AGENT_KERNEL_MANIFEST_SHA256",
				"PRIME_AGENT_PINNED_SOURCE_ROOT",
			])
				vi.stubEnv(name, process.env[name]);
			await runCopiedSessionCanary(
				{
					root,
					sessionFile: file,
					sessionId: id,
					sourceSha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
					durationMs: 1000,
					cycleMs: 1000,
					python: process.env.PRIME_AGENT_TEST_PINNED_PYTHON!,
					manifest: process.env.PRIME_AGENT_TEST_PYTHON_MANIFEST!,
					manifestSha256: process.env.PRIME_AGENT_TEST_PYTHON_MANIFEST_SHA256!,
					sourceRoot: process.env.PRIME_AGENT_TEST_PINNED_SOURCE_ROOT!,
				},
				new AbortController().signal,
			);
			const checkpoint = JSON.parse(readFileSync(join(root, "canary-checkpoint.json"), "utf8"));
			expect(checkpoint).toMatchObject({ phase: "complete", cycle: 2, sessionId: id });
			expect(checkpoint.lastModelRequests).toBeGreaterThanOrEqual(20);
			expect(readFileSync(join(root, "canary-metrics.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
		} finally {
			vi.unstubAllEnvs();
			harness.cleanup();
		}
	},
	90_000,
);
