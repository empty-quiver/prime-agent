import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { initializeSupervisorAnchor, type SupervisorHealth } from "../../src/core/session-supervisor.js";
import { createHarness } from "./harness.js";

const execute = promisify(execFile);

it
	.skipIf(
		process.platform !== "linux" ||
			!process.env.PRIME_AGENT_SUPERVISOR_UNIT ||
			!process.env.PRIME_AGENT_TEST_PINNED_PYTHON,
	)
	.each(["configured", "missing"] as const)(
	"restores the actual systemd entrypoint safely with a %s saved model",
	async (mode) => {
		const harness = await createHarness({
			tools: [],
			persistSession: true,
			autonomous: { enabled: true, maxTurns: 20 },
		});
		const unit = `prime-supervisor-process-test-${randomUUID()}.service`;
		const anchor = join(harness.tempDir, "supervisor.json");
		const config = join(harness.tempDir, "config.json");
		const cli = fileURLToPath(new URL("../../src/cli/supervised-agent.ts", import.meta.url));
		let created = false;
		const show = async (property: string) =>
			(
				await execute("systemctl", ["--user", "show", "--value", `--property=${property}`, unit], { timeout: 2000 })
			).stdout.trim();
		const health = (): SupervisorHealth | undefined => {
			try {
				return JSON.parse(readFileSync(join(harness.tempDir, "health.json"), "utf8"));
			} catch {
				return undefined;
			}
		};
		try {
			harness.session.setSessionName("isolated supervisor process fixture");
			harness.sessionManager.appendMessage(fauxAssistantMessage("synthetic saved context"));
			harness.sessionManager.appendModelChange("canary-local", "fixture");
			writeFileSync(
				join(harness.tempDir, "models.json"),
				JSON.stringify({
					providers: {
						"canary-local": {
							baseUrl: "http://127.0.0.1:0",
							api: "openai-completions",
							apiKey: "synthetic-not-a-credential",
							models: [
								{
									id: "fixture",
									name: "Fixture",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 4096,
								},
							],
						},
					},
				}),
				{ mode: 0o600 },
			);
			await initializeSupervisorAnchor(anchor, harness.session);
			if (mode === "missing") writeFileSync(join(harness.tempDir, "models.json"), JSON.stringify({ providers: {} }));
			const sessionId = harness.session.sessionId;
			const budgetId = harness.session.executionBudget!.cachedState.id;
			await harness.session.disposeAsync();
			writeFileSync(
				config,
				JSON.stringify({
					anchor,
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					pythonManifest: process.env.PRIME_AGENT_TEST_PYTHON_MANIFEST,
					pythonManifestSha256: process.env.PRIME_AGENT_TEST_PYTHON_MANIFEST_SHA256,
					sourceRoot: process.env.PRIME_AGENT_TEST_PINNED_SOURCE_ROOT,
				}),
				{
					mode: 0o600,
				},
			);
			await execute(
				"systemd-run",
				[
					"--user",
					...(mode === "configured" ? ["--collect"] : []),
					`--unit=${unit}`,
					"--property=Type=exec",
					"--property=KillMode=control-group",
					"--property=NotifyAccess=all",
					"--property=WatchdogSec=30s",
					"--property=Restart=on-failure",
					"--property=RestartSec=1s",
					"--property=RestartPreventExitStatus=78",
					"--property=TimeoutStopSec=45s",
					`--property=WorkingDirectory=${process.cwd()}`,
					"/usr/bin/env",
					"PRIME_AGENT_KERNEL_SYSTEMD=1",
					`PRIME_AGENT_SUPERVISOR_UNIT=${unit}`,
					`PRIME_AGENT_KERNEL_PYTHON=${process.env.PRIME_AGENT_TEST_PINNED_PYTHON}`,
					"PI_SKIP_VERSION_CHECK=1",
					`PATH=${process.env.PATH}`,
					process.execPath,
					"--import",
					"tsx",
					cli,
					config,
				],
				{ timeout: 5000 },
			);
			created = true;
			if (mode === "missing") {
				await expect.poll(() => show("ExecMainStatus"), { timeout: 20_000 }).toBe("78");
				expect(health()).toBeUndefined();
				expect(JSON.parse(readFileSync(harness.session.executionBudget!.path!, "utf8")).modelRequests).toBe(0);
				return;
			}
			await expect.poll(() => health()?.state, { timeout: 20_000 }).toBe("idle");
			expect(health()?.sessionId).toBe(sessionId);
			const invocation = await show("InvocationID");
			expect(invocation).toMatch(/^[a-f0-9]{32}$/);
			await execute("systemctl", ["--user", "kill", "--kill-whom=main", "--signal=SIGKILL", unit], {
				timeout: 2000,
			});
			await expect.poll(() => show("NRestarts"), { timeout: 15_000 }).toBe("1");
			await expect.poll(() => show("InvocationID"), { timeout: 15_000 }).not.toBe(invocation);
			const restartedAt = Date.now();
			await expect.poll(() => health()?.checkedAt ?? 0, { timeout: 15_000 }).toBeGreaterThan(restartedAt);
			expect(health()?.sessionId).toBe(sessionId);
			expect(health()?.state).toBe("idle");
			const budget = JSON.parse(readFileSync(harness.session.executionBudget!.path!, "utf8"));
			expect(budget).toMatchObject({ id: budgetId, modelRequests: 0 });
		} catch (error) {
			const log = await execute("journalctl", ["--user", `--unit=${unit}`, "--no-pager", "-n", "30"], {
				timeout: 3000,
			}).catch(() => undefined);
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log?.stdout ?? ""}`);
		} finally {
			if (created && (await show("ExecStart")).includes(config)) {
				await execute("systemctl", ["--user", "stop", unit], { timeout: 50_000 });
				if ((await show("ExecStart")).includes(config))
					await execute("systemctl", ["--user", "reset-failed", unit], { timeout: 2000 });
			}
			await harness.session.disposeAsync();
			harness.cleanup();
		}
	},
	60_000,
);
