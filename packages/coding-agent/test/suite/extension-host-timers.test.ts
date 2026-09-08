import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionTimerHost } from "../../src/core/extensions/host-timers.js";
import type { ExtensionContext, ExtensionError } from "../../src/core/extensions/types.js";
import { createHarness, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
});

describe("host-owned extension timers", () => {
	it("contains synchronous throws, async rejections and throwing diagnostic listeners", async () => {
		vi.useFakeTimers();
		const errors: ExtensionError[] = [];
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const harness = await createHarness({
				tools: [],
				extensionFactories: [
					{
						path: "/timer-owner.ts",
						factory: (pi) =>
							pi.on("session_start", (_event, ctx) => {
								ctx.setTimeout(() => {
									throw new Error("sync callback");
								}, 1);
								ctx.setTimeout(async () => {
									throw new Error("async callback");
								}, 2);
							}),
					},
				],
			});
			harnesses.push(harness);
			const runner = harness.session.extensionRunner;
			runner.onError(() => {
				throw new Error("broken sink");
			});
			runner.onError(async () => {
				throw new Error("async broken sink");
			});
			runner.onError((error) => errors.push(error));
			await runner.emit({ type: "session_start", reason: "startup" });
			await vi.advanceTimersByTimeAsync(10);
			expect(errors.map((error) => [error.extensionPath, error.error])).toEqual([
				["/timer-owner.ts", "sync callback"],
				["/timer-owner.ts", "async callback"],
			]);
			expect(log).toHaveBeenCalledTimes(4);
		} finally {
			log.mockRestore();
		}
	});

	it("does not accumulate overlapping async intervals and cancels pending callbacks on unload", async () => {
		vi.useFakeTimers();
		const host = new ExtensionTimerHost(() => {});
		const ctx = host.forOwner("owner");
		let finish: () => void = () => {};
		const callback = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		ctx.setInterval(callback, 10);
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);
		finish();
		await vi.advanceTimersByTimeAsync(10);
		expect(callback).toHaveBeenCalledTimes(2);
		host.dispose();
		finish();
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(2);
		expect(host.size).toBe(0);
		expect(() => ctx.setTimeout(() => {})).toThrow("stale");
	});

	it("clearing timers releases registry capacity immediately and cannot clear a different owner", () => {
		const host = new ExtensionTimerHost(() => {});
		const ctx = host.forOwner("owner");
		for (let i = 0; i < 10_000; i++) ctx.clearTimeout(ctx.setTimeout(() => {}, 60_000));
		expect(host.size).toBe(0);
		const handle = ctx.setInterval(() => {}, 60_000);
		host.forOwner("other").clearInterval(handle);
		expect(host.size).toBe(1);
		ctx.clearInterval(handle);
		expect(host.size).toBe(0);
		host.dispose();
	});

	it("retires a real Node timeout before callback execution so refresh cannot replay it", async () => {
		const host = new ExtensionTimerHost(() => {});
		const ctx = host.forOwner("owner");
		let calls = 0;
		const handle = ctx.setTimeout(() => {
			calls++;
			handle.refresh();
		}, 1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(calls).toBe(1);
		expect(host.size).toBe(0);
		host.dispose();
	});

	it("adopts timers across an unchanged runtime rebuild and invalidates old contexts at disposal", async () => {
		vi.useFakeTimers();
		let ctx: ExtensionContext | undefined;
		const callback = vi.fn();
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) =>
					pi.on("session_start", (_event, context) => {
						ctx = context;
					}),
			],
		});
		harnesses.push(harness);
		const previous = harness.session.extensionRunner;
		await previous.emit({ type: "session_start", reason: "startup" });
		ctx!.setTimeout(callback, 10);
		const rebuild = Reflect.get(harness.session, "_buildRuntime") as (options: object) => void;
		rebuild.call(harness.session, { activeToolNames: [] });
		expect(harness.session.extensionRunner).not.toBe(previous);
		await vi.advanceTimersByTimeAsync(10);
		expect(callback).toHaveBeenCalledTimes(1);
		ctx!.setTimeout(callback, 10);
		harness.session.dispose();
		await vi.advanceTimersByTimeAsync(10);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(() => ctx!.getSystemPrompt()).toThrow("stale");
	});
});
