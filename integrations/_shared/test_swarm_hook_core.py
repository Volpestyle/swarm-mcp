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

from integrations._shared import herdr_agent_report
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
        self.assertIn('adopt_instance_id="inst-1"', rendered)
        self.assertNotIn("Call the `register` tool", rendered)

    def test_session_start_personal_gateway_loads_herdr_socket_from_profile_env(self) -> None:
        profile_dir = tempfile.mkdtemp(prefix="swarm-test-profile-")
        self.addCleanup(shutil.rmtree, profile_dir, ignore_errors=True)
        expected_socket = "/run/herdr-personal-test.sock"
        with open(os.path.join(profile_dir, "personal.env"), "w") as handle:
            handle.write(f"HERDR_SOCKET_PATH={expected_socket}\n")

        os.environ["SWARM_TEST_IDENTITY"] = "personal"
        os.environ["SWARM_TEST_ROLE"] = "gateway"
        os.environ["SWARM_MCP_PROFILE_DIR"] = profile_dir
        os.environ["HERDR_PANE_ID"] = "pane-1"

        calls: list[list[str]] = []
        herdr_envs: list[dict[str, str]] = []

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

        def fake_subprocess_run(*args, **kwargs):
            herdr_envs.append(kwargs.get("env", {}))
            return mock.Mock(returncode=0, stdout=json.dumps(pane_payload), stderr="")

        with (
            mock.patch.object(self.core, "run_swarm", side_effect=fake_run),
            mock.patch("integrations._shared.swarm_hook_core.shutil.which", return_value="herdr"),
            mock.patch(
                "integrations._shared.swarm_hook_core.subprocess.run",
                side_effect=fake_subprocess_run,
            ),
        ):
            self.run_hook({"session_id": "abc-123", "cwd": "/repo", "source": "startup"})

        self.assertEqual(herdr_envs[0]["HERDR_SOCKET_PATH"], expected_socket)
        identity = json.loads(calls[1][3])
        self.assertEqual(identity["socket_path"], expected_socket)
        self.assertEqual(identity["backend"], "herdr")

    def test_session_start_publishes_configured_work_tracker(self) -> None:
        os.environ["SWARM_TEST_IDENTITY"] = "personal"
        os.environ["SWARM_TEST_WORK_TRACKER"] = json.dumps(
            {
                "provider": "github_issues",
                "mcp": "github_personal",
                "repo": "Volpestyle/swarm-mcp",
            }
        )

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

        with mock.patch.object(self.core, "run_swarm", side_effect=fake_run):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        self.assertEqual(calls[1][:3], ["kv", "set", "config/work_tracker/personal"])
        tracker = json.loads(calls[1][3])
        self.assertEqual(tracker["identity"], "personal")
        self.assertEqual(tracker["provider"], "github_issues")
        self.assertEqual(tracker["mcp"], "github_personal")
        self.assertEqual(tracker["repo"], "Volpestyle/swarm-mcp")
        self.assertEqual(tracker["source"], "env:SWARM_TEST_WORK_TRACKER")
        meta = self.core.read_session_meta("abc-123")
        self.assertTrue(meta["work_tracker_published"])
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Configured work tracker published", rendered)
        self.assertIn("MCP `github_personal`", rendered)

    def test_session_start_reports_herdr_agent_status_when_env_present(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            if args[0] == "register":
                return (
                    0,
                    json.dumps({"id": "inst-1", "scope": "/repo", "file_root": "/repo"}),
                    "",
                )
            return 0, "{}", ""

        with (
            mock.patch.object(self.core, "run_swarm", side_effect=fake_run),
            mock.patch.object(self.core, "_publish_herdr_identity", return_value=True),
            mock.patch(
                "integrations._shared.swarm_hook_core.herdr_agent_report.report_agent",
                return_value=True,
            ) as report_agent,
        ):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        report_agent.assert_called_once_with(
            agent="test-runtime",
            state="idle",
            source="swarm-mcp:test-runtime:inst-1",
            message="swarm session registered",
        )
        meta = self.core.read_session_meta("abc-123")
        self.assertTrue(meta["herdr_agent_reported"])
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Instance `inst-1`", rendered)

    def test_session_start_ignores_herdr_agent_report_exceptions(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            if args[0] == "register":
                return (
                    0,
                    json.dumps({"id": "inst-1", "scope": "/repo", "file_root": "/repo"}),
                    "",
                )
            return 0, "{}", ""

        with (
            mock.patch.object(self.core, "run_swarm", side_effect=fake_run),
            mock.patch.object(self.core, "_publish_herdr_identity", return_value=True),
            mock.patch(
                "integrations._shared.swarm_hook_core.herdr_agent_report.report_agent",
                side_effect=RuntimeError("socket unavailable"),
            ),
        ):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        meta = self.core.read_session_meta("abc-123")
        self.assertEqual(meta["instance_id"], "inst-1")
        self.assertFalse(meta["herdr_agent_reported"])
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("swarm coordination is active", rendered)

    def test_session_start_override_label_preserves_session_token(self) -> None:
        os.environ["SWARM_TEST_LABEL"] = "identity:personal role:researcher topic:debug"

        calls: list[list[str]] = []

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            calls.append(args)
            if args[0] == "register":
                return (
                    0,
                    json.dumps({"id": "inst-override", "scope": "/repo", "file_root": "/repo"}),
                    "",
                )
            return 0, "{}", ""

        with mock.patch.object(self.core, "run_swarm", side_effect=fake_run):
            output = self.run_hook(
                {"session_id": "abc-123", "cwd": "/repo", "source": "startup"}
            )

        self.assertEqual(calls[0][:3], ["register", "/repo", "--label"])
        self.assertIn("identity:personal role:researcher topic:debug", calls[0][3])
        self.assertIn("session:abc123", calls[0][3])
        meta = self.core.read_session_meta("abc-123")
        self.assertIn("session:abc123", meta["label"])
        rendered = json.loads(output)["hookSpecificOutput"]["additionalContext"]
        self.assertIn('adopt_instance_id="inst-override"', rendered)

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
        self.assertIn("bootstrap.work_tracker", rendered)
        self.assertIn("`dispatch`", rendered)
        self.assertIn("`swarm-mcp` skill", rendered)

    def test_gateway_session_start_appends_configured_soul(self) -> None:
        soul_dir = tempfile.mkdtemp(prefix="swarm-test-soul-")
        self.addCleanup(shutil.rmtree, soul_dir, ignore_errors=True)
        soul_path = Path(soul_dir) / "SOUL.md"
        soul_path.write_text("runtime identity prompt\n")
        core = HookCore(
            RuntimeConfig(
                runtime_name="test-runtime",
                env_prefix="TEST",
                scratch_dir_name=f"swarm-test-{uuid4().hex}",
                write_tools=frozenset({"Write"}),
                extract_paths=_extract_paths,
                soul_path=soul_path,
            )
        )
        self.addCleanup(
            shutil.rmtree,
            Path(tempfile.gettempdir()) / core.config.scratch_dir_name,
            True,
        )
        os.environ["SWARM_TEST_ROLE"] = "gateway"

        with mock.patch.object(
            core,
            "run_swarm",
            return_value=(0, json.dumps({"id": "inst-1", "scope": "/repo"}), ""),
        ):
            out = io.StringIO()
            with redirect_stdout(out):
                core.run_session_start_hook(
                    io.StringIO(json.dumps({"session_id": "abc-123", "cwd": "/repo"}))
                )

        rendered = json.loads(out.getvalue())["hookSpecificOutput"]["additionalContext"]
        self.assertIn("## identity / SOUL", rendered)
        self.assertIn("runtime identity prompt", rendered)

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

    def test_session_end_releases_herdr_agent_when_env_present(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"
        self.core.write_session_meta(
            "abc-123",
            {"instance_id": "inst-1", "scope": "/repo", "label": "test-runtime"},
        )
        calls: list[list[str]] = []

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            calls.append(args)
            return 0, "{}", ""

        with (
            mock.patch.object(self.core, "run_swarm", side_effect=fake_run),
            mock.patch(
                "integrations._shared.swarm_hook_core.herdr_agent_report.release_agent",
                return_value=True,
            ) as release_agent,
        ):
            self.core.run_session_end_hook(io.StringIO(json.dumps({"session_id": "abc-123"})))

        release_agent.assert_called_once_with(
            agent="test-runtime",
            source="swarm-mcp:test-runtime:inst-1",
        )
        self.assertEqual(calls[0][:3], ["kv", "del", "identity/workspace/herdr/inst-1"])
        self.assertEqual(calls[1][:3], ["kv", "del", "identity/herdr/inst-1"])
        self.assertEqual(calls[2][:3], ["deregister", "--as", "inst-1"])

    def test_herdr_report_agent_skips_without_required_env(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"

        with mock.patch(
            "integrations._shared.herdr_agent_report.socket.socket"
        ) as socket_factory:
            ok = herdr_agent_report.report_agent(
                agent="codex",
                state="idle",
                source="swarm-mcp:codex:inst-1",
            )

        self.assertFalse(ok)
        socket_factory.assert_not_called()

    def test_herdr_report_agent_returns_false_on_socket_error(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"

        with mock.patch(
            "integrations._shared.herdr_agent_report.socket.socket",
            side_effect=OSError("connect failed"),
        ):
            ok = herdr_agent_report.report_agent(
                agent="codex",
                state="idle",
                source="swarm-mcp:codex:inst-1",
            )

        self.assertFalse(ok)

    def _run_pre_tool(
        self,
        payload: dict,
        locks_response: list[dict] | None = None,
        register_calls: list[list[str]] | None = None,
    ) -> str:
        """Invoke run_pre_tool_use_hook with a stubbed `swarm-mcp locks` response."""

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            if register_calls is not None:
                register_calls.append(args)
            if args and args[0] == "locks":
                return 0, json.dumps(locks_response or []), ""
            return 0, "[]", ""

        out = io.StringIO()
        with mock.patch.object(self.core, "run_swarm", side_effect=fake_run), redirect_stdout(out):
            self.core.run_pre_tool_use_hook(io.StringIO(json.dumps(payload)))
        return out.getvalue()

    def test_pre_tool_allows_write_when_no_locks_exist(self) -> None:
        self.core.write_session_meta(
            "abc-123", {"instance_id": "inst-self", "scope": "/repo"}
        )

        calls: list[list[str]] = []
        output = self._run_pre_tool(
            {
                "session_id": "abc-123",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/file.txt"},
            },
            locks_response=[],
            register_calls=calls,
        )

        self.assertEqual(output, "")
        self.assertEqual(calls[0][:1], ["locks"])
        self.assertIn("--scope", calls[0])
        self.assertEqual(calls[0][calls[0].index("--scope") + 1], "/repo")
        # No acquire / release calls — check-only.
        self.assertFalse(any(args[0] == "lock" for args in calls))
        self.assertFalse(any(args[0] == "unlock" for args in calls))

    def test_pre_tool_blocks_write_when_peer_holds_target(self) -> None:
        self.core.write_session_meta(
            "abc-123", {"instance_id": "inst-self", "scope": "/repo"}
        )

        output = self._run_pre_tool(
            {
                "session_id": "abc-123",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/file.txt"},
            },
            locks_response=[
                {
                    "id": "lock-1",
                    "instance_id": "inst-peer-xyz",
                    "file": "/repo/file.txt",
                    "type": "lock",
                    "content": "refactoring auth flow",
                    "created_at": 0,
                }
            ],
        )

        decision = json.loads(output)
        block = decision["hookSpecificOutput"]
        self.assertEqual(block["hookEventName"], "PreToolUse")
        self.assertEqual(block["permissionDecision"], "deny")
        reason = block["permissionDecisionReason"]
        self.assertIn("swarm lock blocked Write", reason)
        self.assertIn("/repo/file.txt", reason)
        self.assertIn("inst-pee", reason)  # 8-char prefix of holder
        self.assertIn("refactoring auth flow", reason)

    def test_pre_tool_lock_reason_uses_owner_label_and_pane_when_available(self) -> None:
        self.core.write_session_meta(
            "abc-123", {"instance_id": "inst-self", "scope": "/repo"}
        )

        output = self._run_pre_tool(
            {
                "session_id": "abc-123",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/file.txt"},
            },
            locks_response=[
                {
                    "id": "lock-1",
                    "instance_id": "inst-peer-xyz",
                    "owner_label": "role:implementer name:bob",
                    "pane_id": "pane-3",
                    "file": "/repo/file.txt",
                    "type": "lock",
                    "content": "",
                    "created_at": 0,
                }
            ],
        )

        reason = json.loads(output)["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn("held by role:implementer name:bob (pane pane-3)", reason)

    def test_pre_tool_allows_write_when_lock_is_self_held(self) -> None:
        """Re-entrant: an agent that declared a wider critical section keeps editing."""
        self.core.write_session_meta(
            "abc-123", {"instance_id": "inst-self", "scope": "/repo"}
        )

        output = self._run_pre_tool(
            {
                "session_id": "abc-123",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/file.txt"},
            },
            locks_response=[
                {
                    "id": "lock-1",
                    "instance_id": "inst-self",
                    "file": "/repo/file.txt",
                    "type": "lock",
                    "content": "agent-declared critical section",
                    "created_at": 0,
                }
            ],
        )

        self.assertEqual(output, "")

    def test_pre_tool_allows_write_when_peer_holds_unrelated_file(self) -> None:
        self.core.write_session_meta(
            "abc-123", {"instance_id": "inst-self", "scope": "/repo"}
        )

        output = self._run_pre_tool(
            {
                "session_id": "abc-123",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/file.txt"},
            },
            locks_response=[
                {
                    "id": "lock-1",
                    "instance_id": "inst-peer-xyz",
                    "file": "/repo/other.txt",
                    "type": "lock",
                    "content": "different file",
                    "created_at": 0,
                }
            ],
        )

        self.assertEqual(output, "")

    def test_pre_tool_fails_open_when_own_instance_id_unknown(self) -> None:
        """Coordination is opt-in. Without an instance_id we can't distinguish own vs peer locks."""
        self.core.write_session_meta("abc-123", {"scope": "/repo"})

        calls: list[list[str]] = []
        output = self._run_pre_tool(
            {
                "session_id": "abc-123",
                "tool_name": "Write",
                "tool_input": {"file_path": "/repo/file.txt"},
            },
            locks_response=[
                {
                    "id": "lock-1",
                    "instance_id": "inst-peer-xyz",
                    "file": "/repo/file.txt",
                    "type": "lock",
                    "content": "should not matter — we don't know own id",
                    "created_at": 0,
                }
            ],
            register_calls=calls,
        )

        self.assertEqual(output, "")
        # No locks call should fire when we bail before identity check.
        self.assertFalse(any(args[0] == "locks" for args in calls))

    def test_post_tool_use_hook_is_a_noop(self) -> None:
        """Check-only model: nothing was acquired, so post-hook does nothing."""
        calls: list[list[str]] = []

        def fake_run(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
            calls.append(args)
            return 0, "{}", ""

        out = io.StringIO()
        with mock.patch.object(self.core, "run_swarm", side_effect=fake_run), redirect_stdout(out):
            rc = self.core.run_post_tool_use_hook(
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

        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
