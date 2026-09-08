import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/event-log.js";

const faults = vi.hoisted(() => ({ short: false, truncate: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		writeSync: ((fd: number, data: string | Uint8Array) => {
			const buffer = typeof data === "string" ? Buffer.from(data) : data;
			if (faults.short) {
				faults.short = false;
				return actual.writeSync(fd, buffer.subarray(0, Math.floor(buffer.length / 2)));
			}
			return actual.writeSync(fd, buffer);
		}) as typeof fs.writeSync,
		ftruncateSync: ((fd: number, length?: number) => {
			if (faults.truncate) throw new Error("injected EPERM");
			return actual.ftruncateSync(fd, length);
		}) as typeof fs.ftruncateSync,
	};
});

describe("three-fix candidate ledger fault acceptance", () => {
	afterEach(() => {
		faults.short = false;
		faults.truncate = false;
	});
	it("reports a short append as failure and permits later repair", () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "prime-readiness-short-write-"));
		try {
			const path = join(dir, "events.jsonl");
			const log = new EventLog(path);
			log.appendSync([{ id: "before" }]);
			faults.short = true;
			expect(() => log.appendSync([{ id: "lost-event" }], { durable: true })).toThrow(/short write/i);
			expect(log.replaySync((line) => JSON.parse(line))).toEqual([{ id: "before" }]);
			log.appendSync([{ id: "recovered" }], { durable: true });
			expect(log.replaySync((line) => JSON.parse(line))).toEqual([{ id: "before" }, { id: "recovered" }]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("rejects the append without modifying bytes when repair fails", () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "prime-readiness-repair-"));
		try {
			const path = join(dir, "events.jsonl");
			const log = new EventLog(path);
			log.appendSync([{ id: "before" }]);
			fs.appendFileSync(path, '{"torn');
			const before = fs.readFileSync(path, "utf8");
			faults.truncate = true;
			expect(() => log.appendSync([{ id: "after" }])).toThrow(/EPERM/);
			expect(fs.readFileSync(path, "utf8")).toBe(before);
			expect(log.replaySync((line) => JSON.parse(line))).toEqual([{ id: "before" }]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
