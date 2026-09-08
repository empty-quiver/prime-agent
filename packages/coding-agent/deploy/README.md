# Supervised Linux/ARM64 deployment

This is an opt-in, source-checkout deployment. Isolated fault and short-run checks have passed; the operator waived the long-duration soak. Deployment still requires a separate configuration and migration decision, not an automatic replacement of a live installation. The template requires systemd 254 or newer for bounded restart steps. Use a dedicated state family and credentials; do not share OAuth refresh files with older executables.

## Python environment

`kernel-linux-aarch64-py312.txt` pins the runtime's existing locked dependencies plus the bootstrap defaults, bundled skill dependencies and build backend. It targets Linux aarch64 and Python 3.12. Candidate uploads newer than 2026-09-01 were excluded when generated on 2026-09-08. Every registry requirement has distribution hashes.

Provision a **new** dedicated venv with `uv venv --python /path/to/python3.12 /path/to/new-venv`. Install registry dependencies using:

```sh
uv pip sync --python /path/to/new-venv/bin/python --require-hashes --only-binary :all: packages/coding-agent/deploy/kernel-linux-aarch64-py312.txt
```

Then install `./prime-agent-runtime` and the bundled Python skill directories with `uv pip install --python /path/to/new-venv/bin/python --no-deps --no-build-isolation`. Include every bundled skill containing `pyproject.toml`; use ordinary wheel installation, **not editable installation**. The pinned hatchling already installed in the venv supplies the build backend. Do not install additional packages after sealing.

Seal the environment once, after testing it:

```sh
node --import tsx packages/coding-agent/src/cli/seal-pinned-python.ts /absolute/venv/bin/python /absolute/checkout/packages/coding-agent/deploy/kernel-linux-aarch64-py312.txt /absolute/checkout /absolute/state/python-manifest.json
```

Record the returned SHA-256 in supervisor configuration. Sealing checks exact installed distribution versions against the requirements and local projects. The fingerprint covers the interpreter, venv configuration, installed files, extra site-package files, and runtime/skill sources. Verification uses Python `-I -S` so altered site startup hooks are not executed while inspecting them. It rejects editable packages and source/site-package symlinks.

Every supervised startup and kernel start verifies the sealed environment. Kernels launch with `-I`, avoiding ambient Python paths and initial working-directory module shadowing. Missing custom skill packages or changed sources fail closed: explicitly rebuild, test and reseal instead of letting recovery install dependencies. This is reproducibility and drift detection, not a malicious-code sandbox or a claim that the host interpreter has no security vulnerabilities.

## Session initialization and service

Create or copy a complete session family, including its session artifacts. Use the SDK to open the saved session and materialize its durable budget. Call `initializeSupervisorAnchor(anchorPath, session)` from `src/core/session-supervisor.ts` **once**, while that session owns its lease, then await `session.disposeAsync()`.

Place the anchor at the root of the copied family. Session and budget paths must stay inside that root. Anchor version 2 also pins outbound journal identity. Ordinary startup refuses a missing/replaced anchor, budget, inbox or outbox identity; version 1 development anchors require explicit migration after reconciliation, not automatic regeneration. Initialization deliberately refuses to overwrite existing state. An interrupted initialization requires inspection; do not delete identity files to bypass it.

Supervisor configuration uses absolute paths:

```json
{
  "anchor": "/absolute/state/supervisor.json",
  "cwd": "/absolute/project",
  "agentDir": "/absolute/isolated-agent-config",
  "sourceRoot": "/absolute/checkout",
  "pythonManifest": "/absolute/state/python-manifest.json",
  "pythonManifestSha256": "SHA256_RETURNED_BY_SEALING",
  "maxSilentMs": 600000
}
```

Adapt `prime-agent-supervised.service` to the pinned checkout, Node executable, Python and config paths. Install it and `prime-agent.slice` as **user** units, not system units. Kernel scopes verify their owning user-service invocation and cgroup, and bind their lifetime to it. Never start this beside another owner of the same session or another Signal intake for that session.

The saved provider/model must remain configured and available. Unattended startup refuses model fallback rather than switching providers, pricing or capabilities silently. Configure credentials deliberately before deployment; a startup error does not authorize automatic migration to another model.

The supervisor writes `health.json` privately next to the anchor. Durable waits are healthy waiting states; active execution without progress reaches a deadline. Unknown operations or interrupted wake deliveries pause for operator reconciliation. SIGTERM requests cleanup; systemd provides final process containment if the bounded cleanup cannot finish. The dedicated slice limits the aggregate worker and kernel memory to 8 GiB and task count to 2,048. Each kernel scope additionally has a 2 GiB/256-task cap and `OOMPolicy=kill`. Configured slice identity and finite limits are verified before kernel launch. These are containment defaults to tune against measurements, not a fix for retained-memory bugs.

## Signal intake and recovery

Optional `signal` config contains `url`, receiving `account`, `allowNumbers`, and optional `allowGroups`. Plain HTTP is restricted to loopback. Only stable account/sender/device/timestamp identities are admitted; sync echoes are ignored. Message bodies are JSON-framed as untrusted data and do not execute slash commands.

Inbox admission is durable before dispatch. `dispatching` records recovered after a crash become `unknown`; they are not automatically resent. Use `DurableInbox.issues` and `reconcile(id, "processed" | "received", evidence)` only after checking the session and external effects. Choosing `received` explicitly authorizes another attempt. Completed tombstones omit message bodies but retain deduplication history. Capacity exhaustion fails closed rather than forgetting IDs.

The [signal-cli JSON-RPC documentation](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc) documents request IDs for response correlation, not send idempotency. Do not treat a repeated JSON-RPC ID as an exactly-once send guarantee. Interrupted sends remain unknown operations requiring reconciliation. SSE also lacks durable replay acknowledgments: local deduplication cannot recover messages lost upstream of admission.

Optional `signalOutbound` configuration separately specifies `url`, sending `account`, and `allowRecipients`. It enables the `signal_send` tool only for those recipients. The host uses the tool-call ID as its local durable send identity; concurrent duplicate calls and recovered acknowledged calls do not send again. This is local deduplication, not server idempotency. Requests have a 30-second host deadline and bounded responses. Missing/mismatched acknowledgments or failed receipt writes become unknown outcomes, stop automatic continuation, and block further sends and supervisor startup. `DurableOutbox.reconcile()` is an operator API requiring evidence; it is not a model tool. Other outbound adapters must supply their own remote idempotency keys where their services actually support them.

## Validation

The targeted tests include copied-family recovery, duplicate owner refusal, budget identity loss, uncertain inbox dispatch, Signal framing/bounds, pinned runtime drift, real Python execution and SIGKILL/restart of the actual supervisor entrypoint. Linux process tests run only in explicitly isolated user services. No test uses live Signal messages or paid model requests.

The operator waived the 24-hour copied-session soak on 2026-09-08. The isolated run completed two cycles before the requested stop; owned kernels exited and monitoring was paused. This is short-run evidence, not a long-duration pass. See [acceptance results and remaining boundaries](../../../docs/runtime-hardening-status.md).

The optional runner remains available at `test/suite/copied-session-canary-worker.ts`; its two-cycle Linux regression uses the official faux-provider test harness and real pinned kernels. It supports a private copied transcript, no live credentials, a private network namespace, fixed safe cells, four-way child work, durable waits, periodic reopen and retained heap profiles. Do not put real transcripts, manifests containing private paths or heap snapshots into the repository. This template is not an all-provider production-readiness signoff.
