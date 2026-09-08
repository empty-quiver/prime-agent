import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { ExecutionBudget } from "../../src/core/execution-budget.js";
import { verifyPinnedPython } from "../../src/core/kernel/pinned-python.js";
import { verifySupervisorOwnership } from "../../src/core/kernel/systemd-scope.js";
import type { RlmSpawnHandle, RlmSubagentRegistryEntry } from "../../src/core/rlm-runtime.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { initializeSupervisorAnchor, SessionSupervisor } from "../../src/core/session-supervisor.js";
import { parseSignalMessage } from "../../src/core/signal-intake.js";
import { writeFileAtomicSync } from "../../src/utils/atomic-file.js";
import { sleep } from "../../src/utils/sleep.js";
import { createHarness } from "./harness.js";

export interface CanaryConfig {
	root: string;
	sessionFile: string;
	sessionId: string;
	sourceSha256: string;
	durationMs: number;
	cycleMs: number;
	python: string;
	manifest: string;
	manifestSha256: string;
	sourceRoot: string;
}
interface Checkpoint {
	version: 1;
	sessionId: string;
	budgetId: string;
	startedAt: number;
	durationMs: number;
	cycleMs: number;
	cycle: number;
	reopens: number;
	phase: "idle" | "working" | "complete" | "failed";
	baselineResidual?: number;
	lastModelRequests: number;
	lastCycleAt?: number;
}

function response(context: Context) {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		assert.equal(last.isError, false, "Canary Python cell failed");
		return fauxAssistantMessage("CANARY cell completed");
	}
	const text =
		last?.role === "user"
			? typeof last.content === "string"
				? last.content
				: last.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")
			: "";
	if (text.includes("CANARY_EXECUTE"))
		return fauxAssistantMessage(
			fauxToolCall("ipython", {
				code: "import numpy as np\na = np.arange(4096, dtype=np.float64)\nassert int(a.sum()) == 8386560\nprint('CANARY_OUTPUT ' + 'x' * 8192)",
			}),
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage("CANARY lifecycle event observed");
}

/** A copied transcript is data only. No live credentials, extensions, remote APIs or historic cells are replayed. */
export async function runCopiedSessionCanary(config: CanaryConfig, signal: AbortSignal): Promise<void> {
	assert.equal(process.platform, "linux");
	assert.ok([config.root, config.sessionFile, config.python, config.manifest, config.sourceRoot].every(isAbsolute));
	assert.ok(!relative(config.root, config.sessionFile).startsWith(".."));
	assert.ok(
		Number.isSafeInteger(config.durationMs) && config.durationMs >= 1000 && config.durationMs <= 48 * 3600_000,
	);
	assert.ok(Number.isSafeInteger(config.cycleMs) && config.cycleMs >= 1000 && config.cycleMs <= 300_000);
	verifySupervisorOwnership();
	await verifyPinnedPython(config.python, config.manifest, config.manifestSha256, config.sourceRoot, signal);
	Object.assign(process.env, {
		PRIME_AGENT_KERNEL_PYTHON: config.python,
		PRIME_AGENT_KERNEL_MANIFEST: config.manifest,
		PRIME_AGENT_KERNEL_MANIFEST_SHA256: config.manifestSha256,
		PRIME_AGENT_PINNED_SOURCE_ROOT: config.sourceRoot,
	});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("Canary external network request was blocked");
	};
	const harness = await createHarness({
		models: [{ id: "canary", contextWindow: 4_000_000, maxTokens: 4096 }],
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	const checkpointPath = join(config.root, "canary-checkpoint.json");
	const anchor = join(config.root, "supervisor.json");
	const reportPath = join(config.root, "canary-health.json");
	let checkpoint: Checkpoint | undefined;
	let supervisor: SessionSupervisor | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let timerError: unknown;
	const cancel = () => {
		void supervisor?.session.abort().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	const writeCheckpoint = () =>
		writeFileAtomicSync(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600, fsync: true, fsyncDir: true });
	const create = async (file: string, budget?: ExecutionBudget): Promise<AgentSession> => {
		const { session } = await createAgentSession({
			cwd: join(config.root, "work"),
			agentDir: join(config.root, "config"),
			sessionManager: SessionManager.open(file, undefined, join(config.root, "work")),
			model: harness.getModel(),
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			tools: ["ipython"],
			autonomous: { enabled: false },
			executionBudget: budget,
			executionBudgetLimits: {
				maxModelRequests: 20_000,
				maxToolCalls: 30_000,
				maxTokens: 500_000_000_000,
				timeoutMs: config.durationMs + 3600_000,
			},
			prewarmIpythonKernel: false,
		});
		const original = session.agent.streamFn;
		session.agent.streamFn = (model, context, options) => {
			assert.equal(model.provider, "faux");
			return original(model, context, { ...options, cacheRetention: "none" });
		};
		return session;
	};
	const health = () => {
		if (!supervisor || !checkpoint) return;
		const state = supervisor.health();
		writeFileAtomicSync(
			reportPath,
			JSON.stringify({ ...state, ...checkpoint, checkedAt: Date.now(), supervisorState: state.state }),
			{ mode: 0o600 },
		);
		assert.ok(
			!["stalled", "needs_reconciliation", "budget_exhausted"].includes(state.state),
			`Canary unhealthy: ${state.state}`,
		);
	};
	const waitUntil = async (condition: () => boolean, timeoutMs: number) => {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			signal.throwIfAborted();
			if (timerError) throw timerError;
			assert.ok(Date.now() < deadline, "Canary progress deadline exceeded");
			await sleep(Math.min(100, Math.max(1, deadline - Date.now())), signal);
		}
	};
	try {
		for (const path of [join(config.root, "work"), join(config.root, "config"), join(config.root, "profiles")])
			mkdirSync(path, { recursive: true, mode: 0o700 });
		harness.setResponses(Array.from({ length: 100 }, () => response));
		if (existsSync(checkpointPath)) {
			checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
			assert.equal(checkpoint?.version, 1);
			assert.equal(checkpoint.sessionId, config.sessionId);
			assert.equal(checkpoint.durationMs, config.durationMs);
			assert.equal(checkpoint.cycleMs, config.cycleMs);
			assert.equal(checkpoint.phase, "idle", "Interrupted canary work requires inspection, not replay");
			if (checkpoint.lastCycleAt)
				assert.ok(
					Date.now() - checkpoint.lastCycleAt < config.cycleMs + 120_000,
					"Canary coverage gap exceeded its allowance",
				);
		} else {
			assert.equal(createHash("sha256").update(readFileSync(config.sessionFile)).digest("hex"), config.sourceSha256);
			assert.equal(existsSync(anchor), false, "Incomplete initialization requires inspection");
			const seed = await create(config.sessionFile);
			try {
				assert.equal(seed.sessionId, config.sessionId);
				assert.equal(
					seed.recoveryIssues.length,
					0,
					"Copied legacy operations require reconciliation before canary execution",
				);
				await seed.prompt("/goal pause");
				await initializeSupervisorAnchor(anchor, seed);
				checkpoint = {
					version: 1,
					sessionId: config.sessionId,
					budgetId: seed.executionBudget!.cachedState.id,
					startedAt: Date.now(),
					durationMs: config.durationMs,
					cycleMs: config.cycleMs,
					cycle: 0,
					reopens: 0,
					phase: "idle",
					lastModelRequests: 0,
				};
				writeCheckpoint();
			} finally {
				await seed.disposeAsync({ kernelSnapshot: false });
			}
		}
		supervisor = await SessionSupervisor.open(anchor, create, 120_000);
		assert.equal(supervisor.session.executionBudget!.cachedState.id, checkpoint.budgetId);
		timer = setInterval(() => {
			try {
				health();
			} catch (error) {
				timerError = error;
				cancel();
			}
		}, 5000);
		while (Date.now() < checkpoint.startedAt + checkpoint.durationMs || checkpoint.cycle < 2) {
			signal.throwIfAborted();
			if (timerError) throw timerError;
			if (supervisor.session.waitState?.status === "pending" || supervisor.session.waitState?.status === "ready")
				await waitUntil(() => supervisor!.session.waitState?.status === "acknowledged", config.cycleMs + 30_000);
			checkpoint.phase = "working";
			writeCheckpoint();
			harness.setResponses(Array.from({ length: 100 }, () => response));
			const cycle: number = checkpoint.cycle + 1;
			const event: unknown = {
				account: "+15550000001",
				envelope: {
					sourceNumber: "+15550000002",
					sourceDevice: 1,
					dataMessage: { timestamp: checkpoint.startedAt + cycle, message: `CANARY_EXECUTE ${cycle}` },
				},
			};
			const inbound: { id: string; text: string } = parseSignalMessage(event, {
				url: "http://127.0.0.1:0",
				account: "+15550000001",
				allowNumbers: ["+15550000002"],
			})!;
			assert.equal(supervisor.inbox.receive(inbound.id, inbound.text), "accepted");
			assert.equal(supervisor.inbox.receive(inbound.id, inbound.text), "duplicate");
			assert.equal(await supervisor.dispatchOne(), true);
			const children: RlmSpawnHandle[] = await Promise.all(
				Array.from({ length: 4 }, (_, index) =>
					supervisor!.session.runRlmChild(`CANARY_EXECUTE child ${cycle}/${index}`),
				),
			);
			await supervisor.session.waitForRlmQuiescence(signal);
			await supervisor.session.agent.waitForIdle();
			assert.equal(supervisor.session.recoveryIssues.length, 0);
			const listed: RlmSubagentRegistryEntry[] = (await supervisor.session.listRlmSubagents()).subagents;
			for (const child of children) {
				assert.equal(listed.find((entry) => entry.rlm_child_id === child.rlm_child_id)?.status, "completed");
				await supervisor.session.deleteRlmSubagent(child.rlm_child_id);
			}
			const budget = await supervisor.session.executionBudget!.snapshot();
			assert.ok(budget.modelRequests > checkpoint.lastModelRequests);
			checkpoint.lastModelRequests = budget.modelRequests;
			checkpoint.cycle = cycle;
			if (checkpoint.lastCycleAt)
				assert.ok(Date.now() - checkpoint.lastCycleAt < config.cycleMs + 120_000, "Canary cycle stalled");
			checkpoint.lastCycleAt = Date.now();
			globalThis.gc?.();
			const memory = process.memoryUsage();
			const transcriptBytes = statSync(config.sessionFile).size;
			const residual = memory.heapUsed - 4 * transcriptBytes;
			checkpoint.baselineResidual ??= residual;
			assert.ok(memory.heapUsed < 1024 ** 3, "Canary exceeded 1 GiB post-GC heap");
			assert.ok(
				residual - checkpoint.baselineResidual < 128 * 1024 ** 2,
				"Canary retained heap exceeded its transcript-adjusted growth allowance",
			);
			appendFileSync(
				join(config.root, "canary-metrics.jsonl"),
				`${JSON.stringify({
					timestamp: Date.now(),
					cycle,
					...memory,
					transcriptBytes,
					residual,
					modelRequests: budget.modelRequests,
					toolCalls: budget.toolCalls,
					activeResources: process.getActiveResourcesInfo(),
				})}\n`,
				{ mode: 0o600 },
			);
			if (cycle === 1) writeHeapSnapshot(join(config.root, "profiles", "after-first-cycle.heapsnapshot"));
			checkpoint.phase = "idle";
			writeCheckpoint();
			if (cycle % 12 === 0) {
				await supervisor.close();
				supervisor = await SessionSupervisor.open(anchor, create, 120_000);
				assert.equal(supervisor.session.sessionId, checkpoint.sessionId);
				assert.equal(supervisor.session.executionBudget!.cachedState.id, checkpoint.budgetId);
				assert.equal(supervisor.session.executionBudget!.cachedState.modelRequests, checkpoint.lastModelRequests);
				checkpoint.reopens++;
				writeCheckpoint();
			}
			if (Date.now() < checkpoint.startedAt + checkpoint.durationMs)
				supervisor.session.startWait(
					{
						kind: "deadline",
						deadline: Math.min(Date.now() + config.cycleMs, checkpoint.startedAt + checkpoint.durationMs),
					},
					"Canary scheduled next cycle",
				);
			health();
		}
		writeHeapSnapshot(join(config.root, "profiles", "completed.heapsnapshot"));
		assert.ok(
			checkpoint.cycle >= Math.floor((config.durationMs / (config.cycleMs + 30_000)) * 0.9),
			"Insufficient canary cycle coverage",
		);
		checkpoint.phase = "complete";
		writeCheckpoint();
		health();
	} catch (error) {
		if (checkpoint && !signal.aborted) {
			checkpoint.phase = "failed";
			writeCheckpoint();
		}
		writeFileAtomicSync(
			join(config.root, "canary-failure.json"),
			JSON.stringify({
				timestamp: Date.now(),
				error: error instanceof Error ? error.message : String(error),
				checkpoint,
			}),
			{ mode: 0o600, fsync: true },
		);
		throw error;
	} finally {
		clearInterval(timer);
		signal.removeEventListener("abort", cancel);
		await supervisor?.close();
		harness.cleanup();
		globalThis.fetch = originalFetch;
	}
}
