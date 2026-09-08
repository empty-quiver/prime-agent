# Runtime hardening status

This is a development branch, not a production-readiness claim. No supervisor deployment or 24–48-hour canary has been performed.

## Implemented in this branch

### Execution admission (workstream 2)

- Agent-core admits model requests and actual tool execution inside the loop, before dispatch. Failed attempts count; a two-turn endless-tool provider cannot obtain a third request.
- `ExecutionBudget` serializes durable reservations across processes, reconciles successful usage before listeners can attribute child usage, and retains unknown reservations. Restarting with higher requested limits does not replace the saved account or exhaustion.
- Inline children share the account; hosted children inherit it at publication and persist a relative account reference for recovery. Compaction, refinement, branch-summary retries, side questions, daemon status summaries, kernel host requests, and autonomous quality gates also use admission.
- Deadlines abort model/tool work and auxiliary operations. Host waits remain bounded even when a provider ignores cancellation.
- SDK `executionBudgetLimits` configures independent model-request, tool-call, token, cost, and elapsed limits. Explicit autonomous `maxTokens` is a strict reservation cap. The pre-existing **default** 80,000-token continuation target remains a soft target; it is not advertised as a hard cap.
- Strict token admission conservatively reserves the model's full accepted context plus output ceiling. A cap smaller than this allowance refuses admission. Cost caps require an explicit host-supplied worst-case per-request charge; catalog prices alone are not a guaranteed billing bound. Provider violations exhaust the account and are reported, not concealed.

Still to verify: complete daemon recovery and pre-publication extension paths, copied-family account references, and fault-injection coverage for interrupted ledger writes. These are release gates, not production guarantees.

### Kernel cancellation (workstream 3)

- Headless execution requests interruption, allows a one-second grace, sends TERM, allows a further second, and escalates to KILL with a five-second exit-confirmation bound.
- Teardown targets the captured ChildProcess and kernel generation. Replacement cannot proceed while exit is unconfirmed, including after a failed dispose or predecessor gate.
- The interrupted cell is not replayed. Its returned error distinguishes unknown external effects from successful completion.
- Journal-based orphan cleanup now refuses identity-free records on every platform. Existing verified bash-child reaping remains in place.
- Interactive interruption retains its wait/preserve-state choice. Restarting after a busy-before-execution rejection submits the *new* cell, not the interrupted cell.

Remaining boundary: arbitrary detached subprocess trees and already-running host-side requests are not proven contained. Full descendant exit confirmation and worker/cgroup containment still need integration tests. Synchronous process-exit cleanup remains best effort.

### Provider waits and child failure reporting (workstream 4)

- Main provider requests have a five-minute host deadline covering context preparation, credentials and streaming. Agent SDK callers can set a finite `providerTimeoutMs`. This is separate from the execution budget and does not time-limit tools.
- Auxiliary requests also have host deadlines and pass cancellation to built-in consumers. A provider that ignores cancellation cannot hold the host wait indefinitely; the host cannot prove its remote request stopped.
- Timeout diagnostics classify the remote outcome and expenditure as unknown and prohibit automatic retry. Reservations remain held. Explicit caller cancellation remains distinct.
- Failed child assistant messages no longer become successful child completions merely because the prompt promise resolved.
- Durable deadline/job/child waits now persist absolute deadlines, target generations and wake delivery claims. The loop stops while pending; stale/duplicate job notifications cannot wake it. The bundled `agent-wait` Python skill uses the existing host bridge.
- One process-identity lease owns the wait file. Missing/corrupt lease metadata fails closed. A recovered delivery claim is paused, not replayed. Hosts must explicitly call `resumeWait()` after startup/recovery reconciliation; constructor recovery never starts model work before host initialization.
- SDK operators inspect `waitState`/`waitError`, call `notifyWait()` for an external job report, or explicitly `cancelWait()` after reconciliation. Child/job deadlines report timeout when a completion report is missing. External jobs are not implicitly polled.
- Automatic supervisor activation, operation recovery and structured worker-crash recovery remain in progress. No daemon command or event shape changed in this slice; notifications use existing custom-message and diagnostic envelopes.

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

## Remaining work

1. **Budget integration release gates (workstream 2):** complete the remaining recovery, pre-publication, and ledger fault checks listed above; review provider request bounds and cancellation cleanup alongside workstreams 3 and 7.
2. **Explicit waits (workstream 4):** persist typed deadline/job/child conditions and wake generations; end the parent turn without injecting immediate continuations; expose provider deadlines and classify cancellation, timeout, provider failure and worker crash. Retry only when outcome classification permits it.
3. **Extension timers and memory release gates (workstream 6):** complete long-duration canary and Linux worker containment checks. Callback ownership and two bounded retention fixes are implemented; historical OOM attribution remains unknown.
4. **Restart recovery (workstream 7):** durable session identity and one active lease owner; journal operation intent/outcome; reconcile unknown external effects; deduplicate Signal message IDs; use supported idempotency keys; progress-aware health checks; bounded restart backoff; pinned Python dependencies.
5. **Release gate:** run isolated Linux/ARM64 fault tests, review all cross-worker boundaries, then a 24–48-hour copied-session canary with isolated credentials and external effects. No production deployment until these gates pass.

## Verification entry points

Budget coverage: `test/suite/execution-budget.test.ts`, `test/suite/agent-session-autonomous.test.ts`, and `test/provider-retry.test.ts` in coding-agent; `test/agent-loop.test.ts` and `test/agent.test.ts` in agent-core. The budget suite includes a three-OS-process admission race and delegated-child accounting.

From `packages/coding-agent`, use the repository's targeted Vitest command on `test/kernel-termination-safety.test.ts`, `test/oauth-refresh-safety.test.ts`, the kernel abort/startup/shutdown/protocol suites, `test/ipython-provisioner.test.ts`, `test/orphan-process-journal.test.ts`, `test/auth-storage.test.ts`, and the three `test/readiness-*.test.ts` acceptance files.

From `packages/ai`, run `test/oauth-refresh-deadline.test.ts` and the three existing built-in OAuth suites. Tests use synthetic credentials/providers only. The new OAuth suite also races three separate OS processes against one credential file.

Run `npm run check` from the repository root. It performs formatting, type checking, installer checks and the browser-bundle smoke check; it is not a test-suite substitute.
