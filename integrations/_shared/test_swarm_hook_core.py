from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock
from uuid import uuid4

from integrations._shared.swarm_hook_core import HookCore, RuntimeConfig


def _extract_paths(tool_name: str, tool_input: object) -> list[str]:
    if tool_name != "Write" or not isinstance(tool_input, dict):
        return []
    value = tool_input.get("file_path")
    return [value] if isinstance(value, str) else []


class HookCoreLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = mock.patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.scratch_name = f"swarm-test-{uuid4().hex}"
        self.core = HookCore(
            RuntimeConfig(
                runtime_name="test-runtime",
                env_prefix="TEST",
                scratch_dir_name=self.scratch_name,
                write_tools=frozenset({"Write"}),
                extract_paths=_extract_paths,
                auto_lock_note="test lock",
            )
        )

    def tearDown(self) -> None:
        self.env.stop()
        shutil.rmtree(Path(tempfile.gettempdir()) / self.scratch_name, ignore_errors=True)

    def run_hook(self, payload: dict) -> str:
        out = io.StringIO()
        with redirect_stdout(out):
            self.core.run_session_start_hook(io.StringIO(json.dumps(payload)))
        return out.getvalue()

    def test_session_start_registers_and_publishes_herdr_identity(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"

        calls: list[list[str]] = []

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            calls.append(args)
            if args[0] == "register":
                return (
                    0,
                    json.dumps({"id": "inst-1", "scope": "/repo", "file_root": "/repo"}),
                    "",
                )
            if args[:2] == ["kv", "set"]:
                return 0, "", ""
            return 1, "", "unexpected"

        pane_payload = {
            "result": {
                "pane": {
                    "pane_id": "workspace-1",
                    "workspace_id": "workspace",
                    "tab_id": "workspace:1",
                }
            }
        }
        with (
            mock.patch.object(self.core, "run_swarm", side_effect=fake_run),
            mock.patch("integrations._shared.swarm_hook_core.shutil.which", return_value="herdr"),
            mock.patch(
                "integrations._shared.swarm_hook_core.subprocess.run",
                return_value=mock.Mock(
                    returncode=0,
                    stdout=json.dumps(pane_payload),
                    stderr="",
                ),
            ),
        ):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        meta = self.core.read_session_meta("abc-123")
        self.assertEqual(meta["instance_id"], "inst-1")
        self.assertEqual(meta["scope"], "/repo")
        self.assertTrue(meta["herdr_identity_published"])
        self.assertEqual(calls[0][:3], ["register", "/repo", "--label"])
        self.assertIn("test-runtime", calls[0][3])
        self.assertEqual(calls[1][:3], ["kv", "set", "identity/workspace/herdr/inst-1"])
        self.assertEqual(calls[2][:3], ["kv", "set", "identity/herdr/inst-1"])
        identity = json.loads(calls[1][3])
        self.assertEqual(identity["backend"], "herdr")
        self.assertEqual(identity["handle_kind"], "pane")
        self.assertEqual(identity["handle"], "workspace-1")
        self.assertEqual(identity["handle_aliases"], ["pane-1"])
        self.assertEqual(identity["pane_id"], "workspace-1")
        self.assertEqual(identity["pane_aliases"], ["pane-1"])
        self.assertEqual(identity["workspace_id"], "workspace")
        self.assertEqual(identity["tab_id"], "workspace:1")
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("swarm coordination is active", rendered)
        self.assertIn("Instance `inst-1`", rendered)
        self.assertIn("`bootstrap`", rendered)
        self.assertNotIn("Call the `register` tool", rendered)

    def test_session_start_falls_back_to_manual_context_when_register_fails(self) -> None:
        with mock.patch.object(
            self.core,
            "run_swarm",
            return_value=(127, "", "swarm-mcp CLI not found"),
        ):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        meta = self.core.read_session_meta("abc-123")
        self.assertNotIn("instance_id", meta)
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("could not auto-register", rendered)
        self.assertIn("Call the `register` tool", rendered)

    def test_gateway_session_start_surfaces_mode_and_planner_label(self) -> None:
        os.environ["SWARM_TEST_ROLE"] = "gateway"
        os.environ["SWARM_MCP_BIN"] = "bun run /repo/src/cli.ts"

        calls: list[list[str]] = []

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            calls.append(args)
            if args[0] == "register":
                return (
                    0,
                    json.dumps({"id": "inst-1", "scope": "/repo", "file_root": "/repo"}),
                    "",
                )
            return 0, "{}", ""

        with mock.patch.object(self.core, "run_swarm", side_effect=fake_run):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        self.assertIn("mode:gateway", calls[0][3])
        self.assertIn("role:planner", calls[0][3])
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("mode `gateway`", rendered)
        self.assertIn("Gateway/lead mode", rendered)
        self.assertIn("`dispatch`", rendered)
        self.assertIn("`swarm-mcp` skill", rendered)

    def test_session_end_deletes_identity_and_deregisters(self) -> None:
        self.core.write_session_meta(
            "abc-123",
            {"instance_id": "inst-1", "scope": "/repo", "label": "test-runtime"},
        )
        calls: list[list[str]] = []

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            calls.append(args)
            return 0, "{}", ""

        with mock.patch.object(self.core, "run_swarm", side_effect=fake_run):
            self.core.run_session_end_hook(io.StringIO(json.dumps({"session_id": "abc-123"})))

        self.assertEqual(calls[0][:3], ["kv", "del", "identity/workspace/herdr/inst-1"])
        self.assertEqual(calls[1][:3], ["kv", "del", "identity/herdr/inst-1"])
        self.assertEqual(calls[2][:3], ["deregister", "--as", "inst-1"])
        self.assertFalse(self.core.session_scratch("abc-123").joinpath("meta.json").exists())

    def test_gateway_mode_blocks_inline_writes_unless_mirror_allows_path(self) -> None:
        os.environ["SWARM_TEST_ROLE"] = "gateway"
        self.core.write_session_meta("abc-123", {"plugin_role": "gateway", "scope": "/repo"})

        out = io.StringIO()
        with redirect_stdout(out):
            self.core.run_pre_tool_use_hook(
                io.StringIO(
                    json.dumps(
                        {
                            "session_id": "abc-123",
                            "tool_name": "Write",
                            "tool_input": {"file_path": "/repo/file.txt"},
                        }
                    )
                )
            )

        decision = json.loads(out.getvalue())["hookSpecificOutput"]["permissionDecision"]
        self.assertEqual(decision, "deny")

    def test_gateway_inline_write_can_be_explicitly_allowed_for_mirror(self) -> None:
        mirror = Path(tempfile.mkdtemp(prefix="swarm-mirror-")).resolve()
        self.addCleanup(lambda: shutil.rmtree(mirror, ignore_errors=True))
        target = mirror / "file.txt"
        os.environ["SWARM_TEST_ROLE"] = "gateway"
        os.environ["SWARM_TEST_GATEWAY_INLINE_WRITES"] = "1"
        os.environ["SWARM_TEST_GATEWAY_WORKSPACE_MIRROR"] = str(mirror)
        self.core.write_session_meta("abc-123", {"plugin_role": "gateway", "scope": str(mirror)})

        out = io.StringIO()
        with mock.patch.object(self.core, "has_peers", return_value=False), redirect_stdout(out):
            self.core.run_pre_tool_use_hook(
                io.StringIO(
                    json.dumps(
                        {
                            "session_id": "abc-123",
                            "tool_name": "Write",
                            "tool_input": {"file_path": str(target)},
                        }
                    )
                )
            )

        self.assertEqual(out.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
