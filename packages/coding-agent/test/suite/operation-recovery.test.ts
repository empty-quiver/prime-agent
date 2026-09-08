import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { OperationJournal } from "../../src/core/operation-journal.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import * as atomicFile from "../../src/utils/atomic-file.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

it("persists intent before dispatch, blocks interrupted replay across restart, and requires evidence to reconcile", async () => {
	let harness: Harness;
	let executions = 0;
	const tool: AgentTool = {
		name: "external",
		label: "external",
		description: "synthetic external effect",
		parameters: Type.Object({}),
		execute: async () => {
			executions++;
			const directory = join(harness.sessionManager.getSessionArtifactDir()!, "operations");
			const records = readdirSync(directory)
				.filter((file) => file.endsWith(".json"))
				.map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")));
			expect(records.some((record) => record.name === "external" && record.status === "started")).toBe(true);
			return new Promise(() => {});
		},
	};
	harness = await createHarness({
		persistSession: true,
		tools: [tool],
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("external", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("reconciled"),
		]);
		const run = harness.session.prompt("perform an action");
		await vi.waitFor(() => expect(executions).toBe(1));
		harness.session.agent.abort();
		await run;
		expect(harness.session.recoveryIssues).toHaveLength(1);
		const file = harness.sessionManager.getSessionFile()!;
		await harness.session.disposeAsync();
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.open(file),
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			model: harness.getModel(),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			expect(session.recoveryIssues).toHaveLength(1);
			await session.prompt("continue");
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(executions).toBe(1);
			expect(() => session.resumeWait()).toThrow("Reconcile");
			const issue = session.recoveryIssues[0];
			expect(() => session.reconcileOperation(issue.id, "failed", "")).toThrow("evidence");
			session.reconcileOperation(issue.id, "failed", "Synthetic fixture confirmed no external effect occurred");
			await session.prompt("continue after reconciliation");
			expect(session.getLastAssistantText()).toBe("reconciled");
			expect(executions).toBe(1);
		} finally {
			await session.disposeAsync();
		}
	} finally {
		harness.cleanup();
	}
});

it("recovers a known completion without repeating an operation whose transcript output was lost", async () => {
	const harness = await createHarness();
	const directory = join(harness.tempDir, "operations");
	const journal = new OperationJournal(directory);
	try {
		const receipt = await journal.beforeTool("call-one", "external");
		await receipt.settle("succeeded");
		journal.dispose();
		const recovered = new OperationJournal(directory, [{ id: "call-one", name: "external" }]);
		expect(recovered.issues()).toHaveLength(0);
		expect(recovered.recoveredResults).toMatchObject([{ toolCallId: "call-one", status: "succeeded" }]);
		recovered.dispose();
	} finally {
		journal.dispose();
		harness.cleanup();
	}
});

it("imports legacy unfinished cells as unknown and keeps late completions from erasing reconciliation", async () => {
	const journal = new OperationJournal(undefined, [{ id: "legacy", name: "ipython" }]);
	await expect(journal.beforeModel()).rejects.toThrow("Outcome unknown");
	journal.reconcile(journal.issues()[0].id, "failed", "Operator reconciled legacy cell");
	const receipt = await journal.beforeTool("new", "external");
	journal.interruptActive();
	const issue = journal.issues()[0];
	journal.reconcile(issue.id, "failed", "Confirmed action was not committed");
	await receipt.settle("succeeded");
	expect(journal.issues()).toHaveLength(0);
	await journal.beforeModel();
	journal.dispose();
});

it("recovers an intent left by an abruptly exiting OS process", async () => {
	const harness = await createHarness();
	const directory = join(harness.tempDir, "operations");
	try {
		const source = new URL("../../src/core/operation-journal.ts", import.meta.url).href;
		const script = `import { OperationJournal } from ${JSON.stringify(source)};
const journal = new OperationJournal(process.argv[1]);
await journal.beforeTool("crashed-call", "synthetic-external");
process.exit(17);`;
		await expect(
			promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], {
				timeout: 10_000,
			}),
		).rejects.toMatchObject({ code: 17 });
		const recovered = new OperationJournal(directory);
		expect(recovered.issues()).toMatchObject([{ toolCallId: "crashed-call", status: "unknown" }]);
		await expect(recovered.beforeModel()).rejects.toThrow("Outcome unknown");
		recovered.dispose();
	} finally {
		harness.cleanup();
	}
});

it("fails closed when the completion receipt cannot be persisted", async () => {
	const harness = await createHarness();
	const directory = join(harness.tempDir, "operations");
	const journal = new OperationJournal(directory);
	try {
		const receipt = await journal.beforeTool("uncertain", "external");
		const fault = vi.spyOn(atomicFile, "writeFileAtomicSync").mockImplementationOnce(() => {
			throw new Error("synthetic disk failure");
		});
		try {
			await expect(receipt.settle("succeeded")).rejects.toThrow("disk failure");
		} finally {
			fault.mockRestore();
		}
		await expect(journal.beforeModel()).rejects.toThrow("disk failure");
		journal.dispose();
		const recovered = new OperationJournal(directory);
		expect(recovered.issues()).toMatchObject([{ status: "unknown" }]);
		recovered.dispose();
	} finally {
		journal.dispose();
		harness.cleanup();
	}
});
