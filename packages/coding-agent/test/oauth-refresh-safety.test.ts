import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type OAuthCredentials,
	type OAuthProviderInterface,
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthStorageData } from "../src/core/auth-storage.js";

const directories: string[] = [];
const providers: string[] = [];
const expired = { type: "oauth" as const, access: "old-access", refresh: "rotating-token", expires: 1 };
const fresh = { access: "new-access", refresh: "new-rotating-token", expires: Date.now() + 3_600_000 };

afterEach(() => {
	for (const provider of providers.splice(0)) unregisterOAuthProvider(provider);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(refreshToken: OAuthProviderInterface["refreshToken"], options = {}) {
	const directory = mkdtempSync(join(tmpdir(), "prime-oauth-safety-"));
	directories.push(directory);
	const path = join(directory, "auth.json");
	const id = `oauth-test-${providers.length}`;
	providers.push(id);
	registerOAuthProvider({ id, name: id, login: async () => fresh, refreshToken, getApiKey: (cred) => cred.access });
	const first = AuthStorage.create(path, options);
	first.set(id, expired);
	return { first, second: AuthStorage.create(path, options), path, id };
}

function gate<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("OAuth refresh isolation", () => {
	it("serializes refreshes across separate OS processes", async () => {
		const { path, id } = setup(async () => fresh);
		const log = `${path}.requests`;
		const authUrl = pathToFileURL(resolve("src/core/auth-storage.ts")).href;
		const oauthUrl = pathToFileURL(resolve("../ai/src/utils/oauth/index.ts")).href;
		const script = `
import { appendFileSync } from "node:fs";
import { AuthStorage } from ${JSON.stringify(authUrl)};
import { registerOAuthProvider } from ${JSON.stringify(oauthUrl)};
registerOAuthProvider({ id: ${JSON.stringify(id)}, name: "synthetic",
  login: async () => { throw new Error("not used"); },
  refreshToken: async () => {
    appendFileSync(${JSON.stringify(log)}, "refresh\\n");
    await new Promise(r => setTimeout(r, 150));
    return ${JSON.stringify(fresh)};
  }, getApiKey: cred => cred.access });
const auth = AuthStorage.create(${JSON.stringify(path)});
const key = await auth.getApiKey(${JSON.stringify(id)});
if (auth.drainErrors().length) throw new Error("credential operation failed");
process.stdout.write(key ?? "missing");
`;
		const run = () =>
			new Promise<string>((resolveResult, reject) => {
				const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
					cwd: resolve("../.."),
					stdio: ["ignore", "pipe", "pipe"],
				});
				let output = "";
				let error = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
				child.stdout.on("data", (chunk) => {
					output += String(chunk);
				});
				child.stderr.on("data", (chunk) => {
					error += String(chunk);
				});
				child.once("error", reject);
				child.once("close", (code) => {
					clearTimeout(timer);
					if (code === 0) resolveResult(output);
					else reject(new Error(`Refresh child failed: ${error}`));
				});
			});
		expect(await Promise.all([run(), run(), run()])).toEqual([fresh.access, fresh.access, fresh.access]);
		expect(readFileSync(log, "utf8")).toBe("refresh\n");
	}, 15_000);

	it("lets a second provider refresh while the first provider is waiting", async () => {
		const release = gate<OAuthCredentials>();
		const refresh = vi.fn(() => release.promise);
		const { first, id } = setup(refresh);
		const otherId = "oauth-test-independent";
		providers.push(otherId);
		const otherRefresh = vi.fn(async () => fresh);
		registerOAuthProvider({
			id: otherId,
			name: otherId,
			login: async () => fresh,
			refreshToken: otherRefresh,
			getApiKey: (cred) => cred.access,
		});
		first.set(otherId, expired);
		const request = first.getApiKey(id);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		try {
			expect(await first.getApiKey(otherId)).toBe(fresh.access);
			expect(otherRefresh).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve(fresh);
			await request;
		}
		expect(first.drainErrors()).toEqual([]);
	});
	it("serializes racing storage instances and only rotates once", async () => {
		const release = gate<OAuthCredentials>();
		const refresh = vi.fn(() => release.promise);
		const { first, second, id } = setup(refresh);
		const a = first.getApiKey(id);
		const b = second.getApiKey(id);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		release.resolve(fresh);
		expect(await Promise.all([a, b])).toEqual([fresh.access, fresh.access]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(first.drainErrors()).toEqual([]);
		expect(second.drainErrors()).toEqual([]);
	});

	it("does not hold the credential-file lock across the network request", async () => {
		const release = gate<OAuthCredentials>();
		const refresh = vi.fn(() => release.promise);
		const { first, second, path, id } = setup(refresh);
		const request = first.getApiKey(id);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		second.set("unrelated", { type: "api_key", key: "separate-key" });
		second.reload();
		expect(second.drainErrors()).toEqual([]);
		expect(await second.getApiKey("unrelated")).toBe("separate-key");
		release.resolve(fresh);
		expect(await request).toBe(fresh.access);
		const stored = JSON.parse(readFileSync(path, "utf8")) as AuthStorageData;
		expect(stored.unrelated).toEqual({ type: "api_key", key: "separate-key" });
	});

	it("preserves a newer login and does not return the old account's refreshed key", async () => {
		const release = gate<OAuthCredentials>();
		const refresh = vi.fn(() => release.promise);
		const { first, second, path, id } = setup(refresh);
		const request = first.getApiKey(id);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		const newLogin = { ...fresh, type: "oauth" as const, access: "different-account" };
		second.set(id, newLogin);
		release.resolve(fresh);
		expect(await request).toBe("different-account");
		expect((JSON.parse(readFileSync(path, "utf8")) as AuthStorageData)[id]).toEqual(newLogin);
	});

	it("does not resurrect a logged-out credential", async () => {
		const release = gate<OAuthCredentials>();
		const refresh = vi.fn(() => release.promise);
		const { first, second, path, id } = setup(refresh);
		const request = first.getApiKey(id);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		second.removeVerified(id);
		release.resolve(fresh);
		expect(await request).toBeUndefined();
		expect((JSON.parse(readFileSync(path, "utf8")) as AuthStorageData)[id]).toBeUndefined();
	});

	it("bounds a signal-ignoring provider and durably prevents an uncertain refresh from being replayed", async () => {
		const release = gate<OAuthCredentials>();
		let signal: AbortSignal | undefined;
		const refresh = vi.fn<OAuthProviderInterface["refreshToken"]>((_credentials, options) => {
			signal = options?.signal;
			return release.promise;
		});
		const { first, id, path } = setup(refresh, { oauthRefreshTimeoutMs: 30 });
		expect(await first.getApiKey(id)).toBeUndefined();
		expect(signal?.aborted).toBe(true);
		expect(first.drainErrors()[0]?.message).toContain("timed out");
		const restarted = AuthStorage.create(path);
		expect(await restarted.getApiKey(id)).toBeUndefined();
		expect(restarted.drainErrors()[0]?.message).toContain("outcome unknown");
		expect(refresh).toHaveBeenCalledTimes(1);
		release.resolve(fresh);
		await release.promise;
		expect((JSON.parse(readFileSync(path, "utf8")) as AuthStorageData)[id]).toMatchObject({ access: "old-access" });
		await restarted.login(id, { onAuth: () => {}, onPrompt: async () => "" });
		expect(await restarted.getApiKey(id)).toBe(fresh.access);
	});

	it("uses one refresh lock through an auth-file symlink", async () => {
		const release = gate<OAuthCredentials>();
		const refresh = vi.fn(() => release.promise);
		const { first, path, id } = setup(refresh);
		const alias = `${path}.alias`;
		symlinkSync(path, alias);
		const second = AuthStorage.create(alias);
		const a = first.getApiKey(id);
		const b = second.getApiKey(id);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		release.resolve(fresh);
		expect(await Promise.all([a, b])).toEqual([fresh.access, fresh.access]);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
