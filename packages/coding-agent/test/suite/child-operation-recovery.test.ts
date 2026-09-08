import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { OperationJournal } from "../../src/core/operation-journal.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness } from "./harness.js";

it("keeps a child receipt open past admission and recovers a crashed owner without respawning", async () => {
	const harness = await createHarness();
	let recovered: AgentSession | undefined;
	let crashed: { tempDir: string; file: string; childId: string } | undefined;
	try {
		const source = new URL("./harness.ts", import.meta.url).href;
		const script = `import { createHarness } from ${JSON.stringify(source)};
const fixture = await createHarness({ persistSession: true, subagentRuntimeHost: {
 createRlmSubagentRuntime: () => new Promise(() => {}), deleteRlmSubagentRuntime: async () => {}
}});
fixture.session.setSessionName("crashed-parent");
const child = await fixture.session.runRlmChild("never published");
fixture.session.startWait({kind:"child",id:child.rlm_child_id,generation:child.rlm_child_id,deadline:Date.now()+60000}, "child completion");
process.stdout.write(JSON.stringify({tempDir:fixture.tempDir,file:fixture.session.sessionFile,childId:child.rlm_child_id}));
process.exit(17);`;
		try {
			await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				timeout: 15_000,
			});
			throw new Error("Fixture did not crash");
		} catch (error) {
			expect(error).toMatchObject({ code: 17 });
			crashed = JSON.parse((error as { stdout: string }).stdout);
		}
		expect(crashed!.tempDir.startsWith(join(tmpdir(), "pi-suite-"))).toBe(true);
		recovered = (
			await createAgentSession({
				cwd: crashed!.tempDir,
				agentDir: crashed!.tempDir,
				sessionManager: SessionManager.open(crashed!.file),
				model: harness.getModel(),
				modelRegistry: harness.session.modelRegistry,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				noTools: "all",
			})
		).session;
		expect(recovered.recoveryIssues).toMatchObject([
			{ toolCallId: `child:${crashed!.childId}`, name: "rlm.run child", status: "unknown" },
		]);
		harness.setResponses([fauxAssistantMessage("reconciled child outcome")]);
		await expect(recovered.prompt("continue")).rejects.toThrow("durable wait");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(() => recovered!.resumeWait()).toThrow("Reconcile");
		recovered.reconcileOperation(
			recovered.recoveryIssues[0].id,
			"failed",
			"Fixture stopped before child runtime publication; no external work occurred",
		);
		recovered.resumeWait();
		await vi.waitFor(() => expect(recovered!.waitState?.status).toBe("acknowledged"));
		expect(recovered.waitState?.outcome).toBe("failed");
		expect(recovered.getLastAssistantText()).toBe("reconciled child outcome");
	} finally {
		await recovered?.disposeAsync();
		harness.cleanup();
		if (crashed?.tempDir.startsWith(join(tmpdir(), "pi-suite-")))
			rmSync(crashed.tempDir, { recursive: true, force: true });
	}
}, 25_000);

it("settles a successful child's lifetime and restores its known result without replay", async () => {
	const harness = await createHarness({
		persistSession: true,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	try {
		harness.setResponses([
			fauxAssistantMessage("child complete"),
			fauxAssistantMessage("parent observed completion"),
		]);
		const handle = await harness.session.runRlmChild("finish");
		const directory = join(harness.sessionManager.getSessionArtifactDir()!, "operations");
		await vi.waitFor(() => {
			const records = readdirSync(directory)
				.filter((name) => name.endsWith(".json"))
				.map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ toolCallId: `child:${handle.rlm_child_id}`, status: "succeeded" }),
				]),
			);
		});
		await harness.session.disposeAsync();
		const journal = new OperationJournal(directory);
		expect(journal.find(`child:${handle.rlm_child_id}`)?.status).toBe("succeeded");
		expect(journal.issues()).toHaveLength(0);
		journal.dispose();
	} finally {
		await harness.session.disposeAsync();
		harness.cleanup();
	}
});
