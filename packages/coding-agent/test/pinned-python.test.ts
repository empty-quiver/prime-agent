import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { sealPinnedPython, verifyPinnedPython } from "../src/core/kernel/pinned-python.js";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";

it("rejects manifest replacement and source traversal without starting Python", async () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-pinned-validation-"));
	const manifest = join(directory, "manifest.json");
	try {
		writeFileSync(manifest, JSON.stringify({ version: 1, sources: { "..": "invalid" }, snapshot: {} }));
		await expect(verifyPinnedPython("/must-not-execute", manifest, "0".repeat(64), directory)).rejects.toThrow(
			"identity changed",
		);
		const digest = createHash("sha256").update(readFileSync(manifest)).digest("hex");
		await expect(verifyPinnedPython("/must-not-execute", manifest, digest, directory)).rejects.toThrow("escaped");
		const requirements = join(directory, "requirements.txt");
		writeFileSync(requirements, "unpinned==1.0\n");
		await expect(
			sealPinnedPython("/must-not-execute", requirements, directory, [], join(directory, "new.json")),
		).rejects.toThrow("distribution hash");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it.skipIf(process.platform !== "linux" || process.arch !== "arm64")(
	"fingerprints a real venv without executing altered site startup hooks",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-pinned-venv-"));
		const venv = join(directory, "venv");
		const python = join(venv, "bin/python");
		const requirements = join(directory, "requirements.txt");
		const manifest = join(directory, "manifest.json");
		const marker = join(directory, "must-not-run");
		try {
			await promisify(execFile)("/usr/bin/python3", ["-m", "venv", "--without-pip", venv], { timeout: 10_000 });
			writeFileSync(requirements, ""); // Empty, network-free environment fixture.
			const digest = await sealPinnedPython(python, requirements, directory, [], manifest);
			await verifyPinnedPython(python, manifest, digest, directory);
			const site = join(venv, "lib/python3.12/site-packages");
			mkdirSync(site, { recursive: true });
			writeFileSync(
				join(site, "sitecustomize.py"),
				`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('unexpected execution')\n`,
			);
			await expect(verifyPinnedPython(python, manifest, digest, directory)).rejects.toThrow("contents changed");
			expect(existsSync(marker)).toBe(false);
			await expect(sealPinnedPython(python, requirements, directory, [], manifest)).rejects.toThrow(
				"already exists",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	20_000,
);

it.skipIf(!process.env.PRIME_AGENT_TEST_PINNED_PYTHON)(
	"starts the real pinned runtime in a contained kernel and executes a local cell",
	async () => {
		const python = process.env.PRIME_AGENT_TEST_PINNED_PYTHON!;
		const manifest = process.env.PRIME_AGENT_TEST_PYTHON_MANIFEST!;
		const digest = process.env.PRIME_AGENT_TEST_PYTHON_MANIFEST_SHA256!;
		const root = process.env.PRIME_AGENT_TEST_PINNED_SOURCE_ROOT!;
		const directory = mkdtempSync(join(tmpdir(), "prime-pinned-kernel-"));
		vi.stubEnv("PRIME_AGENT_KERNEL_PYTHON", python);
		vi.stubEnv("PRIME_AGENT_KERNEL_MANIFEST", manifest);
		vi.stubEnv("PRIME_AGENT_KERNEL_MANIFEST_SHA256", digest);
		vi.stubEnv("PRIME_AGENT_PINNED_SOURCE_ROOT", root);
		const manager = new ReplKernelManager({ cwd: directory, python });
		try {
			await verifyPinnedPython(python, manifest, digest, root);
			await manager.start();
			const result = await manager.execute("import numpy, scipy, pandas, agent_wait\nprint(6 * 7)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("42");
			const alternate = new ReplKernelManager({ cwd: directory, python: "/must-not-execute" });
			await expect(alternate.start()).rejects.toThrow("differs from the pinned deployment");
			await alternate.kill();
		} finally {
			await manager.kill();
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	},
	45_000,
);
