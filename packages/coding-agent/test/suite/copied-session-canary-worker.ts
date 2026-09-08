import { readFileSync } from "node:fs";
import { runCopiedSessionCanary } from "./copied-session-canary.js";

const abort = new AbortController();
process.once("SIGTERM", () => abort.abort(new Error("Canary service stopped")));
process.once("SIGINT", () => abort.abort(new Error("Canary interrupted")));
try {
	await runCopiedSessionCanary(JSON.parse(readFileSync(process.argv[2], "utf8")), abort.signal);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 78;
}
