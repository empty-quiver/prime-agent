import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

bridge = types.ModuleType("rlm")
bridge.host_request = AsyncMock(return_value={"wait": {"id": "one"}})
sys.modules["rlm"] = bridge
sys.path.insert(0, str(Path(__file__).parent / "src"))
import agent_wait


class WaitBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_deadline(self):
        result = await agent_wait.until(deadline_ms=12345, reason="deadline")
        self.assertEqual(result["wait"]["id"], "one")
        bridge.host_request.assert_awaited_with("wait.start", {
            "condition": {"kind": "deadline", "deadline": 12345}, "reason": "deadline",
        })

    async def test_child_generation(self):
        await agent_wait.child("child-uuid", deadline_ms=12345, reason="child")
        bridge.host_request.assert_awaited_with("wait.start", {
            "condition": {"kind": "child", "id": "child-uuid", "generation": "child-uuid",
                          "deadline": 12345}, "reason": "child",
        })

    async def test_job_and_status(self):
        await agent_wait.job("job", "generation", deadline_ms=12345, reason="job")
        bridge.host_request.assert_awaited_with("wait.start", {
            "condition": {"kind": "job", "id": "job", "generation": "generation",
                          "deadline": 12345}, "reason": "job",
        })
        await agent_wait.status()
        bridge.host_request.assert_awaited_with("wait.status")


if __name__ == "__main__":
    unittest.main()
