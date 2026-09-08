# Extension timer lifetime

Extension event handlers, commands, tools and shortcuts can use `ctx.setTimeout`, `ctx.clearTimeout`, `ctx.setInterval` and `ctx.clearInterval`. Callbacks can return promises. Both synchronous exceptions and rejected promises are reported with the owning extension path. Errors in diagnostic listeners are also contained.

Use the context's clear methods to release host registry capacity immediately. Handles are real Node timer handles (including `ref` and `unref`). A completed timeout is retired before invoking its callback; refreshing it cannot replay a completed callback. One extension cannot clear another extension's host timer.

Async intervals skip ticks while the preceding callback is unsettled. They do not build a queue of overlapping callbacks. Reload, session replacement and disposal cancel pending callbacks. Already executing JavaScript cannot be forcibly cancelled: callbacks should still use cancellation-aware operations and must not repeat uncertain external effects. Native global timers are not intercepted or sandboxed.

Timers survive a runtime rebuild when the loaded extension instances are unchanged, such as MCP tool refresh. Their errors route to the current runner. Unload invalidates captured timer contexts. Weak handle tracking and finalization avoid retaining globally cleared handles indefinitely; a 4096-entry host limit bounds registry metadata even before GC. Prefer `ctx.clearTimeout` and `ctx.clearInterval`, not global clearing.

The implementation adopts the ownership/error-boundary design reviewed in upstream [#2095](https://github.com/PrimeIntellect-ai/prime-agent/pull/2095) at `58a3b159b0373bae83553c6884cea581d34f1ea1`, with additional interval-overlap, diagnostic-listener and metadata-cap protections. It is not a cherry-pick of the PR.

## Memory investigation

`packages/coding-agent/scripts/hardening-memory-profile.ts` runs only synthetic workloads: 10,000 completed sleeps sharing four cancellation signals, then three batches of four concurrent sessions with 2,000 2-KiB transcript entries each. It captures V8 heap snapshots and post-GC measurements. Run from that package with:

```sh
node --expose-gc --import tsx scripts/hardening-memory-profile.ts /absolute/path/to/new-profile-directory
```

On macOS arm64, Node 24.16.0, September 8, 2026:

| Measurement | Before sleep fix | After sleep fix |
| --- | ---: | ---: |
| Abort listeners after completed sleeps | 10,000 | 0 |
| Post-GC heap before workload | 69,451,920 B | 69,449,616 B |
| Post-GC heap after sleeps | 74,301,144 B | 68,409,032 B |
| Post-GC heap after final transcript batch | 75,770,680 B | 69,871,144 B |

This establishes a retained-listener defect, not the cause of the historical Spark OOM. Snapshot collection itself substantially increases RSS; do not interpret profiling RSS as ordinary serving memory. Three transcript batches are not a long-duration canary. Long-running tool updates now retain only unsettled delivery promises; the 100,000-update regression verifies completed deliveries leave no entries. Unsettled external callbacks, full transcripts and intentionally retained child sessions still require duration/concurrency testing.
