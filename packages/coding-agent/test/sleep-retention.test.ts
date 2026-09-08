import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { sleep } from "../src/utils/sleep.js";

afterEach(() => vi.useRealTimers());

it("releases abort listeners after completed sleeps", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	for (let i = 0; i < 1000; i++) {
		const pending = sleep(1, controller.signal);
		await vi.advanceTimersByTimeAsync(1);
		await pending;
	}
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	expect(vi.getTimerCount()).toBe(0);
});

it("releases timers and listeners after cancellation and rejects already aborted sleeps", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const pending = expect(sleep(1000, controller.signal)).rejects.toThrow("Aborted");
	controller.abort();
	await pending;
	await expect(sleep(1000, controller.signal)).rejects.toThrow("Aborted");
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	expect(vi.getTimerCount()).toBe(0);
});
