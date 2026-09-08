import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DurableInbox } from "../../src/core/durable-inbox.js";
import { OperationJournal } from "../../src/core/operation-journal.js";
import { journalFiles, readJournalJson } from "../../src/utils/bounded-journal.js";
import { createHarness } from "./harness.js";

it("rejects oversized and symlinked records before parsing or allocating the body", async () => {
	const harness = await createHarness();
	try {
		const directory = join(harness.tempDir, "journal");
		mkdirSync(directory);
		const path = join(directory, "large.json");
		writeFileSync(path, "x".repeat(65_537));
		expect(() => readJournalJson(path, 65_536)).toThrow("size limit");
		expect(() => new OperationJournal(directory)).toThrow("size limit");
		const links = join(harness.tempDir, "links");
		mkdirSync(links);
		symlinkSync(path, join(links, "link.json"));
		expect(() => [...journalFiles(links)]).toThrow("regular file");
		expect(() => new DurableInbox(links)).toThrow("regular file");
	} finally {
		harness.cleanup();
	}
});

it("bounds outstanding intents without dropping unknown recovery evidence", async () => {
	const journal = new OperationJournal();
	for (let index = 0; index < 1024; index++) await journal.beforeTool(`call:${index}`, "fixture");
	await expect(journal.beforeTool("overflow", "fixture")).rejects.toThrow("pending limit");
	await expect(journal.beforeModel()).rejects.toThrow("pending limit");
	journal.interruptActive();
	const records = journal.issues();
	expect(records).toHaveLength(1024);
	expect(records.every((record) => record.status === "unknown")).toBe(true);
	journal.dispose();
});
