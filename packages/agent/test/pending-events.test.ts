import { expect, it } from "vitest";
import { PendingEvents } from "../src/pending-events.js";

it("retains only pending deliveries across 100000 completed updates", async () => {
	const events = new PendingEvents();
	for (let batch = 0; batch < 100; batch++) {
		for (let i = 0; i < 1000; i++) events.add(Promise.resolve());
		await events.settle();
		expect(events.size).toBe(0);
	}
	for (let i = 0; i < 100_000; i++) events.add(undefined);
	expect(events.size).toBe(0);
});

it("handles rejection immediately and preserves the original failure through settlement", async () => {
	const events = new PendingEvents();
	events.add(Promise.reject(new Error("listener failed")));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(events.size).toBe(0);
	await expect(events.settle()).rejects.toThrow("listener failed");
});

it("waits for pending deliveries", async () => {
	const events = new PendingEvents();
	let finish: () => void = () => {};
	events.add(
		new Promise<void>((resolve) => {
			finish = resolve;
		}),
	);
	let settled = false;
	const pending = events.settle().then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	finish();
	await pending;
	expect(events.size).toBe(0);
});
