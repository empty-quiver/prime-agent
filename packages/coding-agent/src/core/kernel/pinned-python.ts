import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";

interface PythonSnapshot {
	python: string;
	platform: string;
	machine: string;
	executable: string;
	siteDigest: string;
	venvConfig: string;
	packages: Record<string, { version: string; digest: string }>;
}
export interface PinnedPythonManifest {
	version: 1;
	requirementsDigest: string;
	sources: Record<string, string>;
	snapshot: PythonSnapshot;
}

const inspectPython = String.raw`
import hashlib, importlib.metadata as metadata, json, pathlib, platform, re, sys
root = pathlib.Path(sys.argv[1]).resolve()
config = (root / "pyvenv.cfg").read_bytes()
if not re.search(rb"(?m)^include-system-site-packages\s*=\s*false\s*$", config): raise RuntimeError("Pinned Python must exclude system site packages")
site = root / "lib" / ("python%d.%d" % sys.version_info[:2]) / "site-packages"
packages = {}
for distribution in metadata.distributions(path=[str(site)]):
    name = re.sub(r"[-_.]+", "-", distribution.metadata["Name"]).lower()
    if name in packages: raise RuntimeError("Duplicate Python distribution: " + name)
    direct = distribution.read_text("direct_url.json")
    if direct and json.loads(direct).get("dir_info", {}).get("editable"): raise RuntimeError("Editable Python distributions are not pinned")
    files = distribution.files
    if not files: raise RuntimeError("Python distribution has no file inventory: " + name)
    digest = hashlib.sha256()
    for file in sorted(files, key=str):
        if str(file).endswith(".pyc"): continue
        path = pathlib.Path(distribution.locate_file(file)).resolve()
        if not path.is_relative_to(root): raise RuntimeError("Distribution file escaped pinned environment")
        digest.update(str(file).encode()); digest.update(b"\0")
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1048576), b""): digest.update(chunk)
        digest.update(b"\0")
    packages[name] = {"version": distribution.version, "digest": digest.hexdigest()}
with open(sys.executable, "rb") as stream: executable = hashlib.file_digest(stream, "sha256").hexdigest()
site_digest = hashlib.sha256()
for path in sorted(site.rglob("*")):
    if path.is_symlink(): raise RuntimeError("Pinned site packages cannot contain symlinks")
    if not path.is_file() or path.suffix == ".pyc" or "__pycache__" in path.parts: continue
    site_digest.update(str(path.relative_to(site)).encode()); site_digest.update(b"\0")
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""): site_digest.update(chunk)
    site_digest.update(b"\0")
print(json.dumps({"python": platform.python_version(), "platform": sys.platform, "machine": platform.machine(), "executable": executable, "siteDigest": site_digest.hexdigest(), "venvConfig": hashlib.sha256(config).hexdigest(), "packages": dict(sorted(packages.items()))}, sort_keys=True))
`;

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

async function snapshotPython(python: string, signal?: AbortSignal): Promise<PythonSnapshot> {
	if (!isAbsolute(python)) throw new Error("Pinned Python requires an absolute executable path");
	const result = await promisify(execFile)(python, ["-I", "-S", "-c", inspectPython, dirname(dirname(python))], {
		timeout: 30_000,
		maxBuffer: 2_097_152,
		signal,
	});
	return JSON.parse(result.stdout) as PythonSnapshot;
}

function sourceDigest(root: string, source: string): string {
	if (isAbsolute(source)) throw new Error("Pinned source paths must be relative");
	const directory = realpathSync(resolve(root, source));
	const fromRoot = relative(realpathSync(root), directory);
	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
		throw new Error("Pinned source escaped checkout");
	const hash = createHash("sha256");
	const visit = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if ([".venv", "__pycache__", ".git", "dist"].includes(entry.name)) continue;
			if (entry.isSymbolicLink()) throw new Error("Pinned source trees cannot contain symlinks");
			const file = join(path, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && (entry.name.endsWith(".py") || entry.name === "pyproject.toml")) {
				hash.update(relative(directory, file));
				hash.update("\0");
				hash.update(readFileSync(file));
				hash.update("\0");
			}
		}
	};
	visit(directory);
	return hash.digest("hex");
}

/** Seal only after hash-checked dependency installation and non-editable local package installation. */
export async function sealPinnedPython(
	python: string,
	requirements: string,
	sourceRoot: string,
	sources: string[],
	output: string,
): Promise<string> {
	if (existsSync(output)) throw new Error("Pinned Python manifest already exists; refusing replacement");
	const requirementsText = readFileSync(requirements, "utf8");
	const expected = new Map<string, string>();
	let hasHash = true;
	for (const line of requirementsText.split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		if (line.trimStart().startsWith("--hash=")) {
			if (!expected.size || !/^--hash=sha256:[a-f0-9]{64}(?:\s*\\)?$/.test(line.trim()))
				throw new Error("Invalid pinned requirement hash");
			hasHash = true;
			continue;
		}
		if (!hasHash) throw new Error("Every pinned requirement needs a distribution hash");
		const match = line.match(/^([A-Za-z0-9_.-]+)==([^\s;]+)(?:\s*\\)?$/);
		if (!match) throw new Error("Pinned requirements must contain exact versions and hashes without markers");
		if (expected.has(normalizeName(match[1]))) throw new Error("Duplicate pinned requirement");
		expected.set(normalizeName(match[1]), match[2]);
		hasHash = false;
	}
	if (!hasHash) throw new Error("Every pinned requirement needs a distribution hash");
	const sourceHashes: Record<string, string> = {};
	for (const source of [...sources].sort()) {
		sourceHashes[source] = sourceDigest(sourceRoot, source);
		const project = readFileSync(resolve(sourceRoot, source, "pyproject.toml"), "utf8")
			.split(/^\[project\]\s*$/m)[1]
			?.split(/^\[/m)[0];
		const name = project?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
		const version = project?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
		if (!name || !version) throw new Error("Pinned local project requires a static name and version");
		expected.set(normalizeName(name), version);
	}
	const snapshot = await snapshotPython(python);
	if (snapshot.platform !== "linux" || snapshot.machine !== "aarch64" || !snapshot.python.startsWith("3.12."))
		throw new Error("This dependency lock targets Linux aarch64 Python 3.12");
	if (
		Object.keys(snapshot.packages).length !== expected.size ||
		[...expected].some(([name, version]) => snapshot.packages[name]?.version !== version)
	)
		throw new Error("Installed Python packages do not exactly match pinned requirements and local sources");
	const manifest: PinnedPythonManifest = {
		version: 1,
		requirementsDigest: digest(requirementsText),
		sources: sourceHashes,
		snapshot,
	};
	const text = JSON.stringify(manifest);
	writeFileAtomicSync(output, text, { mode: 0o600, fsync: true, fsyncDir: true });
	return digest(text);
}

/** Read-only verification; never repairs, installs or blesses a changed environment during restart. */
export async function verifyPinnedPython(
	python: string,
	manifestPath: string,
	expectedDigest: string,
	sourceRoot: string,
	signal?: AbortSignal,
): Promise<PinnedPythonManifest> {
	const text = readFileSync(manifestPath, "utf8");
	if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest(text) !== expectedDigest)
		throw new Error("Pinned Python manifest identity changed");
	const manifest: PinnedPythonManifest = JSON.parse(text);
	if (manifest.version !== 1 || !manifest.sources || !manifest.snapshot)
		throw new Error("Invalid pinned Python manifest");
	for (const [source, expected] of Object.entries(manifest.sources))
		if (sourceDigest(sourceRoot, source) !== expected)
			throw new Error("Pinned Python source changed; rebuild and validate the environment explicitly");
	const actual = await snapshotPython(python, signal);
	if (JSON.stringify(actual) !== JSON.stringify(manifest.snapshot))
		throw new Error("Pinned Python interpreter or installed package contents changed");
	return manifest;
}
