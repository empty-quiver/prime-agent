import { getEventListeners, setMaxListeners } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { sleep } from "../src/utils/sleep.js";
import { createHarness } from "../test/suite/harness.js";

const output = resolve(process.argv[2] ?? "hardening-memory-profile");
mkdirSync(output, { recursive: true });
if (!globalThis.gc) throw new Error("Run with --expose-gc");
const controllers = Array.from({ length: 4 }, () => new AbortController());
for (const controller of controllers) setMaxListeners(0, controller.signal);
const samples: object[] = [];
function sample(stage: string) {
	globalThis.gc!();
	samples.push({ stage, ...process.memoryUsage(), abortListeners: controllers.reduce(
		(total, controller) => total + getEventListeners(controller.signal, "abort").length, 0,
	) });
}
sample("baseline");
writeHeapSnapshot(join(output, "baseline.heapsnapshot"));
for (let batch = 0; batch < 10; batch++) {
	await Promise.all(controllers.flatMap((controller) => Array.from({ length: 250 }, () => sleep(1, controller.signal))));
}
sample("10000-completed-sleeps");
writeHeapSnapshot(join(output, "completed-sleeps.heapsnapshot"));
for (let batch = 0; batch < 3; batch++) {
	await Promise.all(Array.from({ length: 4 }, async () => {
		const harness = await createHarness({ tools: [] });
		try {
			harness.session.agent.state.messages = Array.from({ length: 2000 }, (_, i) => ({
				role: "user" as const, content: `Synthetic transcript ${i}: ${"x".repeat(2048)}`, timestamp: i,
			}));
			harness.setResponses([{ text: "Synthetic completion" }]);
			await harness.session.prompt("Profile a long transcript without external actions");
		} finally { harness.cleanup(); }
	}));
	sample(`transcript-batch-${batch + 1}`);
}
writeHeapSnapshot(join(output, "after-transcripts.heapsnapshot"));
writeFileSync(join(output, "measurements.json"), JSON.stringify(samples, null, 2));
console.log(JSON.stringify(samples, null, 2));
