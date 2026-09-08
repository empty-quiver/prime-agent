---
name: agent-wait
description: Suspend this session until a deadline, a child completion, or a generation-matched external job report. Use instead of repeatedly polling unchanged work.
---

# Durable waits

Import `agent_wait` in the Python kernel. These calls persist a host wait and return immediately. End the cell immediately afterward: do not sleep, poll, or perform further external actions. The host ends the model turn and wakes the session when the condition resolves.

```python
import agent_wait
await agent_wait.until(deadline_ms=1788883200000, reason="scheduled check")
# Or use a handle returned by rlm:
await agent_wait.child(handle.rlm_child_id, deadline_ms=1788883200000, reason="child result")
```

Deadlines are absolute Unix epoch milliseconds; compute a deadline appropriate to the current task, not the example value. Every child/job wait requires a deadline so a lost report cannot suspend forever. `await agent_wait.status()` returns the durable record and any local failure.

`await agent_wait.job(job_id, generation, deadline_ms=..., reason=...)` is for an external job whose host integration calls `session.notifyWait(wait_id, "job", job_id, generation, outcome)`. It does not itself poll arbitrary processes, URLs, or files. A reused job ID must have a new generation. Completion outcomes include completed, failed, cancelled, timeout and worker_crash.

Wait status is not proof that external actions succeeded. A deadline or failed child requires checking the actual outcome. A restart during wake delivery pauses for operator reconciliation instead of replaying the wake. Operators can inspect SDK `session.waitState` and explicitly `session.cancelWait()` after reconciliation. Only one wait may be pending. A wake turn may schedule its next wait.
