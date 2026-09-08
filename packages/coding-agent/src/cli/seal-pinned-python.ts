import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { sealPinnedPython } from "../core/kernel/pinned-python.js";

const [python, requirements, sourceRoot, manifest] = process.argv.slice(2);
if (![python, requirements, sourceRoot, manifest].every((value) => typeof value === "string" && isAbsolute(value))) {
	throw new Error(
		"Usage: seal-pinned-python <absolute-python> <absolute-requirements> <absolute-checkout> <absolute-manifest>",
	);
}
const sources = ["prime-agent-runtime"];
for (const entry of readdirSync(join(sourceRoot, "packages/coding-agent/skills"), { withFileTypes: true })) {
	const source = `packages/coding-agent/skills/${entry.name}`;
	if (entry.isDirectory() && existsSync(join(sourceRoot, source, "pyproject.toml"))) sources.push(source);
}
const sha256 = await sealPinnedPython(python, requirements, sourceRoot, sources, manifest);
console.log(JSON.stringify({ manifest, sha256 }));
