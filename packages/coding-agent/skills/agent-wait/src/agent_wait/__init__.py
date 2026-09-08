"""Durable waits; calls return immediately and the host suspends the model loop."""

from typing import Any

from rlm import host_request


async def until(*, deadline_ms: int, reason: str) -> dict[str, Any]:
    return await host_request("wait.start", {
        "condition": {"kind": "deadline", "deadline": deadline_ms}, "reason": reason,
    })


async def child(child_id: str, *, deadline_ms: int, reason: str) -> dict[str, Any]:
    return await host_request("wait.start", {
        "condition": {"kind": "child", "id": child_id, "generation": child_id,
                      "deadline": deadline_ms}, "reason": reason,
    })


async def job(job_id: str, generation: str, *, deadline_ms: int, reason: str) -> dict[str, Any]:
    return await host_request("wait.start", {
        "condition": {"kind": "job", "id": job_id, "generation": generation,
                      "deadline": deadline_ms}, "reason": reason,
    })


async def status() -> dict[str, Any]:
    return await host_request("wait.status")
