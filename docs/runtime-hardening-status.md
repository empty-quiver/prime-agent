# Runtime hardening status

This is a development branch, not a production-readiness claim. An isolated supervisor restart test has passed on Linux/ARM64. No production supervisor deployment or 24–48-hour canary has been performed.

## Implemented in this branch

### Execution admission (workstream 2)

- Agent-core admits model requests and actual tool execution inside the loop, before dispatch. Failed attempts count; a two-turn endless-tool provider cannot obtain a third request.
- `ExecutionBudget` serializes durable reservations across processes, reconciles successful usage before listeners can attribute child usage, and retains unknown reservations. Restarting with higher requested limits does not replace the saved account or exhaustion.
- Inline and hosted children receive the shared account before construction or extension startup and persist a canonical relative account reference for recovery. The production runtime factory forwards budget options. Compaction, refinement, branch-summary retries, side questions, daemon status summaries, kernel host requests, and autonomous quality gates also use admission.
- Deadlines abort model/tool work and auxiliary operations. Host waits remain bounded even when a provider ignores cancellation.
- SDK `executionBudgetLimits` configures independent model-request, tool-call, token, cost, and elapsed limits. Explicit autonomous `maxTokens` is a strict reservation cap. The pre-existing **default** 80,000-token continuation target remains a soft target; it is not advertised as a hard cap.
- Strict token admission conservatively reserves the model's full accepted context plus output ceiling. A cap smaller than this allowance refuses admission. Cost caps require an explicit host-supplied worst-case per-request charge; catalog prices alone are not a guaranteed billing bound. Provider violations exhaust the account and are reported, not concealed.

- A separately persisted account identity prevents a missing or replaced ledger from silently resetting allowance. Inconsistent saved deadlines fail closed. Coverage includes pre-publication runtime/daemon child requests, write failures, identity loss/replacement, and copied-family recovery through the SDK.

The opt-in supervisor additionally anchors the budget ID outside its ledger and refuses missing state even when both the ledger and its identity marker have disappeared. Complete daemon recovery and interruption at every filesystem commit boundary remain release gates.

### Kernel cancellation (workstream 3)

- Headless execution requests interruption, allows a one-second grace, sends TERM, allows a further second, and escalates to KILL with a five-second exit-confirmation bound.
- Teardown targets the captured ChildProcess and kernel generation. Replacement cannot proceed while exit is unconfirmed, including after a failed dispose or predecessor gate.
- The interrupted cell is not replayed. Its returned error distinguishes unknown external effects from successful completion.
- Journal-based orphan cleanup now refuses identity-free records on every platform. Existing verified bash-child reaping remains in place.
- Interactive interruption retains its wait/preserve-state choice. Restarting after a busy-before-execution rejection submits the *new* cell, not the interrupted cell.
- Opt-in Linux systemd scopes inherit the kernel environment without putting credentials on the command line. Scope invocation IDs and cgroup membership identify ownership; cleanup confirms the cgroup is empty, including detached descendants. The declared supervisor must contain the caller and use `KillMode=control-group`.
- Protocol repair and failed startup now await confirmed cleanup before discarding manager state. An interrupted cell is rejected, not replayed. Scopes bind to the supervisor so its death also stops kernel descendants.
- Linux/ARM64 integration tests passed for TERM-resistant detached descendants, early kernel exits, supervisor SIGKILL, and all 22 protocol-repair regressions. Enable with `PRIME_AGENT_KERNEL_SYSTEMD=1` and `PRIME_AGENT_SUPERVISOR_UNIT=<owning-user-service>.service`; this is not enabled on production.

- Agent-core now joins opted-in tool cleanup independently of the aborted execution signal, even if recording the unknown receipt fails. IPython opts into a 30-second maximum. Failed or unconfirmed cleanup is explicit, and aborted post-tool hooks do not overwrite that outcome. A full faux-provider session test confirms a TERM-resistant kernel exits before cancellation completes, without replay.

- Synchronous disposal now quiesces wake callbacks and retains the session lease until active runs, owned kernels and children finish cleanup. Failed cleanup quarantines ownership and is surfaced by `disposeAsync()`. The lease cannot be handed to a replacement merely because `dispose()` returned.

Remaining boundary: containment requires the supervised Linux configuration. Arbitrary host-side callbacks cannot be forcibly stopped in-process. Synchronous process-exit cleanup remains best effort outside systemd.

### Provider waits and child failure reporting (workstream 4)

- Main provider requests have a five-minute host deadline covering context preparation, credentials and streaming. Agent SDK callers can set a finite `providerTimeoutMs`. This is separate from the execution budget and does not time-limit tools.
- Auxiliary requests also have host deadlines and pass cancellation to built-in consumers. A provider that ignores cancellation cannot hold the host wait indefinitely; the host cannot prove its remote request stopped.
- Timeout diagnostics classify the remote outcome and expenditure as unknown and prohibit automatic retry. Reservations remain held. Explicit caller cancellation remains distinct.
- Failed child assistant messages no longer become successful child completions merely because the prompt promise resolved.
- Durable deadline/job/child waits now persist absolute deadlines, target generations and wake delivery claims. The loop stops while pending; stale/duplicate job notifications cannot wake it. The bundled `agent-wait` Python skill uses the existing host bridge.
- One process-identity lease owns the wait file. Missing/corrupt lease metadata fails closed. A recovered delivery claim is paused, not replayed. Hosts must explicitly call `resumeWait()` after startup/recovery reconciliation; constructor recovery never starts model work before host initialization.
- SDK operators inspect `waitState`/`waitError`, call `notifyWait()` for an external job report, or explicitly `cancelWait()` after reconciliation. Child/job deadlines report timeout when a completion report is missing. External jobs are not implicitly polled.
- The opt-in supervisor activates pending waits only after checking recovery state and binding extensions. Recovered in-flight wake delivery remains paused. Complete daemon child-worker recovery remains a release gate. No daemon command or event shape changed; notifications use existing custom-message and diagnostic envelopes.

### OAuth refresh isolation (workstream 5)

- Refresh serialization uses a distinct cross-process lock per canonical auth file and provider (one account slot per provider in the current schema).
- Shared credential locks only cover reads and atomic writes. Writes fsync the file and request directory fsync where supported.
- A durable refresh-attempt generation is written before network dispatch; commit compares the complete prepared credential, including that generation.
- Concurrent login, logout, and account changes win over stale refresh results.
- Built-in refreshes receive cancellation and a 30-second network deadline. The host also bounds custom providers that ignore cancellation, rejects late results, and retains uncertain-attempt markers.
- An uncertain refresh requires a fresh login; it is not automatically replayed after restart. This deliberately favors avoiding rotating-token races over transparent retries.

Mixed-version warning: an older executable does not understand the new attempt marker. Do not share this credential file with older refresh writers during a canary. External tools and separately copied credential files are outside this lock domain.

### Extension lifetimes and measured retention (workstream 6)

- Added per-extension host timers following the reviewed ownership approach of #2095; synchronous and asynchronous callback failures are contained, including failed diagnostic listeners. Unload cancels pending callbacks; async intervals do not overlap.
- Bounded timer registry metadata and released completed tool-update promises instead of retaining them until tool completion.
- Reproduced and fixed a retry-sleep leak: 10,000 completed sleeps retained 10,000 abort listeners before the fix and zero afterward. Captured heap snapshots under four-way concurrent synthetic long transcripts; see [measurements and limitations](extension-timer-hardening.md).
- These findings do not establish the historical OOM's root cause. Long-duration memory and controlled worker containment remain release gates.

### Operation recovery (workstream 7)

- Actual tool and kernel host requests persist intent before execution, then a known success/failure or unknown outcome. Arguments and credentials are not included in receipts. A returned failure does not mean partial external effects were rolled back.
- Cancellation preserves unknown outcomes, including outstanding nested host requests. Late completion callbacks cannot erase an operator's reconciliation. On restart, unfinished intents and legacy unanswered tool calls block primary and auxiliary model admission.
- SDK `recoveryIssues` exposes unknown operations. `reconcileOperation(id, outcome, evidence)` requires operator evidence and is not exposed as a model tool. Known completions missing transcript results receive a recovery notice instead of replay.
- Coverage includes restart through the SDK, an abruptly exiting separate OS process, failed completion-receipt writes, legacy unfinished cells and late completion races.
- Completed receipt files are retained on disk; long-session receipt retention/compaction remains a release gate. This journal does not provide exactly-once semantics for remote services or contain an escaped process.
- The opt-in supervisor persists a one-time session/budget/inbox identity anchor. Startup never creates a replacement session or allowance. Paths remain inside the copied state family, and one process-identity lease owns the supervisor.
- Durable inbox records precede dispatch, survive process crashes and reject changed payloads with the same message ID. Interrupted delivery is unknown, not automatically replayed. Completed tombstones retain deduplication identity but omit message bodies. Pending records and total tombstones have fail-closed capacity limits.
- Signal intake uses account/sender/device/timestamp/group identity, explicit sender/group allowlists, bounded buffers and connection/idle deadlines. It ignores sync echoes and fails closed on an event it cannot durably admit. The Signal SSE endpoint has no durable replay acknowledgment: messages lost upstream of local admission are not recoverable by this bridge.
- The systemd template uses a watchdog, bounded restart backoff, startup-error restart prevention, memory limits and process-group teardown. Its standalone entrypoint writes private progress-aware health state and pauses uncertain operations instead of retrying them.
- Linux/ARM64 validation passed 33 tests across seven files, including SIGKILL of the actual supervisor entrypoint followed by same-session restart with unchanged budget identity and usage. The live Spark service and Signal bridge were not changed.
- Added exact, hash-checked Linux/ARM64 Python 3.12 dependency pins and non-editable runtime/skill installation. Sealed fingerprints are checked at supervisor and kernel startup without running site startup hooks during inspection. Changed environments fail closed instead of reinstalling dependencies. Four additional Linux tests passed, including real pinned Python kernel execution and supervisor restart with fingerprint verification. See [deployment and recovery instructions](../packages/coding-agent/deploy/README.md).

## Remaining work

1. **Budget integration release gates (workstream 2):** complete the remaining recovery, pre-publication, and ledger fault checks listed above; review provider request bounds and cancellation cleanup alongside workstreams 3 and 7.
2. **Explicit waits (workstream 4):** persist typed deadline/job/child conditions and wake generations; end the parent turn without injecting immediate continuations; expose provider deadlines and classify cancellation, timeout, provider failure and worker crash. Retry only when outcome classification permits it.
3. **Extension timers and memory release gates (workstream 6):** complete long-duration canary and Linux worker containment checks. Callback ownership and two bounded retention fixes are implemented; historical OOM attribution remains unknown.
4. **Restart integration (workstream 7):** finish outbound idempotency/outcome handling and complete child-worker recovery; validate the deployment template and run the canary. The opt-in supervisor, pinned Python verification, wait activation, Signal deduplication, health checks and bounded-backoff template are implemented and isolated restart-tested, but not production-deployed.
5. **Release gate:** run isolated Linux/ARM64 fault tests, review all cross-worker boundaries, then a 24–48-hour copied-session canary with isolated credentials and external effects. No production deployment until these gates pass.

## Verification entry points

Budget coverage: `test/suite/execution-budget.test.ts`, `test/suite/execution-budget-recovery.test.ts`, `test/suite/agent-session-autonomous.test.ts`, and `test/provider-retry.test.ts` in coding-agent; `test/agent-loop.test.ts` and `test/agent.test.ts` in agent-core. The budget suites include a three-OS-process admission race, pre-publication delegated accounting, write faults, and copied-family recovery.

From `packages/coding-agent`, use the repository's targeted Vitest command on `test/kernel-termination-safety.test.ts`, `test/oauth-refresh-safety.test.ts`, the kernel abort/startup/shutdown/protocol suites, `test/ipython-provisioner.test.ts`, `test/orphan-process-journal.test.ts`, `test/auth-storage.test.ts`, and the three `test/readiness-*.test.ts` acceptance files.

From `packages/ai`, run `test/oauth-refresh-deadline.test.ts` and the three existing built-in OAuth suites. Tests use synthetic credentials/providers only. The new OAuth suite also races three separate OS processes against one credential file.

Run `npm run check` from the repository root. It performs formatting, type checking, installer checks and the browser-bundle smoke check; it is not a test-suite substitute.
