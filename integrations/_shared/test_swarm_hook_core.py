"""Trust-boundary checks for the shared write reservation hooks."""
import contextlib
import io
import json
import os
import unittest
from unittest.mock import patch
from .swarm_hook_core import HookCore, RuntimeConfig


class WriteHooksTest(unittest.TestCase):
    def test_binding_and_reservation_failures_deny_writes(self):
        core = HookCore(RuntimeConfig(frozenset({"Write"}), lambda *_: ["/file"]))
        payload = {"tool_name": "Write", "session_id": "native", "tool_use_id": "call"}
        bound = {"SWARM_COORDINATOR_CLIENT": '["client"]',
                 "SWARM_COORDINATOR_ENDPOINT": "endpoint", "SWARM_SESSION_CAPABILITY": "capability",
                 "SWARM_COORDINATOR_HOOK_OWNER": "launcher", "SWARM_NATIVE_SESSION_ID": "native"}
        for env in [{}, {**bound, "SWARM_NATIVE_SESSION_ID": "other"}]:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True), patch(
                    "integrations._shared.swarm_hook_core.leased_writes.enter") as enter:
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    core.run_pre_tool_use_hook(io.StringIO(json.dumps(payload)))
                self.assertEqual(json.loads(out.getvalue())["hookSpecificOutput"]["permissionDecision"], "deny")
                enter.assert_not_called()
        with patch.dict(os.environ, bound, clear=True), patch(
                "integrations._shared.swarm_hook_core.leased_writes.enter", side_effect=RuntimeError("unavailable")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                core.run_pre_tool_use_hook(io.StringIO(json.dumps(payload)))
            self.assertIn("unavailable", out.getvalue())
        with self.assertRaises((ValueError, json.JSONDecodeError)):
            core.run_pre_tool_use_hook(io.StringIO("[]"))


if __name__ == "__main__":
    unittest.main()
