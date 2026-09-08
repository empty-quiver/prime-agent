# Runtime hardening status

This is a development branch, not a production-readiness claim. No supervisor deployment or 24–48-hour canary has been performed.

## Implemented in this branch

### Kernel cancellation (workstream 3)

- Headless execution requests interruption, allows a one-second grace, sends TERM, allows a further second, and escalates to KILL with a five-second exit-confirmation bound.
- Teardown targets the captured ChildProcess and kernel generation. Replacement cannot proceed while exit is unconfirmed, including after a failed dispose or predecessor gate.
- The interrupted cell is not replayed. Its returned error distinguishes unknown external effects from successful completion.
- Journal-based orphan cleanup now refuses identity-free records on every platform. Existing verified bash-child reaping remains in place.
- Interactive interruption retains its wait/preserve-state choice. Restarting after a busy-before-execution rejection submits the *new* cell, not the interrupted cell.

Remaining boundary: arbitrary detached subprocess trees and already-running host-side requests are not proven contained. Full descendant exit confirmation and worker/cgroup containment still need integration tests. Synchronous process-exit cleanup remains best effort.

### OAuth refresh isolation (workstream 5)

- Refresh serialization uses a distinct cross-process lock per canonical auth file and provider (one account slot per provider in the current schema).
- Shared credential locks only cover reads and atomic writes. Writes fsync the file and request directory fsync where supported.
- A durable refresh-attempt generation is written before network dispatch; commit compares the complete prepared credential, including that generation.
- Concurrent login, logout, and account changes win over stale refresh results.
- Built-in refreshes receive cancellation and a 30-second network deadline. The host also bounds custom providers that ignore cancellation, rejects late results, and retains uncertain-attempt markers.
- An uncertain refresh requires a fresh login; it is not automatically replayed after restart. This deliberately favors avoiding rotating-token races over transparent retries.

Mixed-version warning: an older executable does not understand the new attempt marker. Do not share this credential file with older refresh writers during a canary. External tools and separately copied credential files are outside this lock domain.

## Remaining work

1. **Authoritative budgets (workstream 2):** one durable host-owned account shared by root, retries and delegated workers. Admit every model request and actual tool execution; reserve concurrent token/cost allowance before dispatch; reconcile usage; conservatively retain reservations on unknown outcomes; persist exhaustion before returning; enforce elapsed deadlines through cancellation. The existing autonomous `maxTurns` defect is not fixed by this branch yet.
2. **Explicit waits (workstream 4):** persist typed deadline/job/child conditions and wake generations; end the parent turn without injecting immediate continuations; expose provider deadlines and classify cancellation, timeout, provider failure and worker crash. Retry only when outcome classification permits it.
3. **Extension timers and memory (workstream 6):** review/adopt upstream #2095 at pinned head `58a3b159b0373bae83553c6884cea581d34f1ea1`, test synchronous/async callback failures and unload ownership, then collect heap profiles with representative transcript length and concurrency. No retained-memory root cause has been established.
4. **Restart recovery (workstream 7):** durable session identity and one active lease owner; journal operation intent/outcome; reconcile unknown external effects; deduplicate Signal message IDs; use supported idempotency keys; progress-aware health checks; bounded restart backoff; pinned Python dependencies.
5. **Release gate:** run isolated Linux/ARM64 fault tests, review all cross-worker boundaries, then a 24–48-hour copied-session canary with isolated credentials and external effects. No production deployment until these gates pass.

## Verification entry points

From `packages/coding-agent`, use the repository's targeted Vitest command on `test/kernel-termination-safety.test.ts`, `test/oauth-refresh-safety.test.ts`, the kernel abort/startup/shutdown/protocol suites, `test/ipython-provisioner.test.ts`, `test/orphan-process-journal.test.ts`, `test/auth-storage.test.ts`, and the three `test/readiness-*.test.ts` acceptance files.

From `packages/ai`, run `test/oauth-refresh-deadline.test.ts` and the three existing built-in OAuth suites. Tests use synthetic credentials/providers only. The new OAuth suite also races three separate OS processes against one credential file.

Run `npm run check` from the repository root. It performs formatting, type checking, installer checks and the browser-bundle smoke check; it is not a test-suite substitute.
