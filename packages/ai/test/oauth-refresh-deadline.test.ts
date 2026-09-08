import { afterEach, describe, expect, it, vi } from "vitest";
import {
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	openaiCodexOAuthProvider,
} from "../src/utils/oauth/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("built-in OAuth refresh cancellation", () => {
	it.each([anthropicOAuthProvider, githubCopilotOAuthProvider, openaiCodexOAuthProvider])(
		"$id passes host cancellation through to the network",
		async (provider) => {
			let signal: AbortSignal | null | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn((_url: string, options: RequestInit) => {
					signal = options.signal;
					return new Promise<Response>((_resolve, reject) => {
						if (signal?.aborted) reject(signal.reason);
						else signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
					});
				}),
			);
			const controller = new AbortController();
			const operation = provider.refreshToken(
				{ refresh: "synthetic", access: "expired", expires: 1 },
				{ signal: controller.signal },
			);
			const rejected = expect(operation).rejects.toThrow();
			controller.abort(new Error("test cancellation"));
			await rejected;
			expect(signal?.aborted).toBe(true);
		},
	);
});
