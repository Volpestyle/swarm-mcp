from __future__ import annotations

import json
import logging
import os
import unittest
from unittest import mock

from integrations.hermes import cli, lifecycle


class SwarmRoleConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        # Most tests in this file simulate a session launched via an identity
        # wrapper (hermesp/hermesw); set AGENT_IDENTITY here so on_session_start
        # passes the identity gate by default. Tests that exercise the
        # no-identity skip path clear or override this explicitly.
        self._env = mock.patch.dict(
            os.environ, {"AGENT_IDENTITY": "test"}, clear=True
        )
        self._env.start()
        lifecycle._instances.clear()
        lifecycle._refcounts.clear()
        lifecycle._warned_missing_identity = False
        if hasattr(lifecycle, "_roles_by_session"):
            lifecycle._roles_by_session.clear()

    def tearDown(self) -> None:
        self._env.stop()
        lifecycle._instances.clear()
        lifecycle._refcounts.clear()
        lifecycle._warned_missing_identity = False
        if hasattr(lifecycle, "_roles_by_session"):
            lifecycle._roles_by_session.clear()

    def _start_with_config(self, config: dict, session_id: str = "session-123") -> None:
        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            self.assertEqual(tool_suffix, "register")
            return {"id": f"inst-{session_id}"}

        with mock.patch.object(lifecycle, "_load_config", return_value=config), mock.patch.object(
            lifecycle, "_dispatch", side_effect=fake_dispatch
        ), mock.patch("integrations.hermes.workspace_identity.publish_current_identity"):
            lifecycle.on_session_start(session_id=session_id, platform="telegram")

    def test_missing_swarm_role_defaults_to_worker(self) -> None:
        self._start_with_config({})

        self.assertEqual(lifecycle.get_role("session-123"), "worker")

    def test_gateway_role_is_read_and_cached_at_session_start(self) -> None:
        self._start_with_config({"swarm": {"role": "gateway"}})

        self.assertEqual(lifecycle.get_role("session-123"), "gateway")

    def test_invalid_role_warns_and_defaults_to_worker(self) -> None:
        with self.assertLogs(lifecycle.logger.name, level=logging.WARNING) as logs:
            self._start_with_config({"swarm": {"role": "planner"}})

        self.assertEqual(lifecycle.get_role("session-123"), "worker")
        self.assertIn("invalid swarm.role", "\n".join(logs.output))

    def test_env_role_overrides_config_role(self) -> None:
        # Gateway launcher aliases export SWARM_HERMES_ROLE=gateway; it must
        # take precedence over swarm.role in the hermes config file so the
        # shell launcher is the single source of truth for plugin role.
        os.environ["SWARM_HERMES_ROLE"] = "gateway"
        self._start_with_config({"swarm": {"role": "worker"}})

        self.assertEqual(lifecycle.get_role("session-123"), "gateway")

    def test_env_role_invalid_warns_and_defaults_to_worker(self) -> None:
        os.environ["SWARM_HERMES_ROLE"] = "planner"
        with self.assertLogs(lifecycle.logger.name, level=logging.WARNING) as logs:
            self._start_with_config({"swarm": {"role": "gateway"}})

        self.assertEqual(lifecycle.get_role("session-123"), "worker")
        self.assertIn("invalid SWARM_HERMES_ROLE", "\n".join(logs.output))

    def test_role_labels_remain_orthogonal_to_plugin_role(self) -> None:
        os.environ["SWARM_HERMES_LABEL"] = "identity:personal role:planner custom:x"

        args = lifecycle._register_args("session-123", {"platform": "telegram"})

        self.assertIn("role:planner", args["label"])
        self.assertNotIn("role:gateway", args["label"])
        self.assertNotIn("role:worker", args["label"])
        self.assertIn("session:session1", args["label"])

    def test_override_label_gets_identity_and_session_from_contract(self) -> None:
        os.environ["SWARM_HERMES_LABEL"] = "role:researcher custom:x"
        os.environ["SWARM_HERMES_IDENTITY"] = "personal"

        args = lifecycle._register_args("abc-123", {"platform": "telegram"})

        self.assertEqual(
            args["label"],
            "identity:personal role:researcher custom:x session:abc123",
        )

    def test_identity_falls_back_to_named_hermes_profile(self) -> None:
        # Active-profile fallback only kicks in when no identity env is set.
        os.environ.pop("AGENT_IDENTITY", None)
        with mock.patch.object(lifecycle, "_identity_from_active_profile", return_value="personal"):
            args = lifecycle._register_args("abc-123", {"platform": "telegram"})

        self.assertIn("identity:personal", args["label"])
        self.assertNotIn("identity:unknown", args["label"])

    def test_session_start_skips_register_when_no_identity_signal(self) -> None:
        # Raw `hermes` invocations leave AGENT_IDENTITY unset and should not
        # register at all — no ghost peer with identity:unknown.
        os.environ.pop("AGENT_IDENTITY", None)
        calls: list[tuple[str, dict]] = []

        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            calls.append((tool_suffix, args))
            return {}

        with mock.patch.object(
            lifecycle, "_identity_from_active_profile", return_value=""
        ), mock.patch.object(lifecycle, "_dispatch", side_effect=fake_dispatch):
            with self.assertLogs(lifecycle.logger.name, level=logging.WARNING) as logs:
                lifecycle.on_session_start(session_id="abc-123", platform="telegram")

        self.assertEqual(calls, [])
        self.assertNotIn("abc-123", lifecycle._instances)
        self.assertIn("registration skipped", "\n".join(logs.output))

    def test_session_start_allow_unlabeled_opt_back_in(self) -> None:
        # SWARM_MCP_ALLOW_UNLABELED=1 restores legacy unlabeled registration.
        os.environ.pop("AGENT_IDENTITY", None)
        os.environ["SWARM_MCP_ALLOW_UNLABELED"] = "1"

        calls: list[tuple[str, dict]] = []

        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            calls.append((tool_suffix, args))
            if tool_suffix == "register":
                return {"id": "inst-unlabeled"}
            return {}

        with mock.patch.object(
            lifecycle, "_identity_from_active_profile", return_value=""
        ), mock.patch.object(lifecycle, "_dispatch", side_effect=fake_dispatch), mock.patch(
            "integrations.hermes.workspace_identity.publish_current_identity"
        ):
            lifecycle.on_session_start(session_id="abc-123", platform="telegram")

        self.assertEqual(calls[0][0], "register")
        self.assertNotIn("identity:", calls[0][1]["label"])

    def test_session_start_publishes_configured_work_tracker(self) -> None:
        os.environ["SWARM_HERMES_IDENTITY"] = "work"
        calls: list[tuple[str, dict]] = []

        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            calls.append((tool_suffix, args))
            if tool_suffix == "register":
                return {"id": "inst-work"}
            if tool_suffix == "kv_set":
                return {"ok": True}
            return {}

        config = {
            "swarm": {
                "role": "worker",
                "work_tracker": {
                    "work": {
                        "provider": "linear",
                        "mcp": "linear_work",
                        "team": "ENG",
                    }
                },
            }
        }

        with mock.patch.object(lifecycle, "_load_config", return_value=config), mock.patch.object(
            lifecycle, "_dispatch", side_effect=fake_dispatch
        ), mock.patch("integrations.hermes.workspace_identity.publish_current_identity"):
            lifecycle.on_session_start(session_id="session-123", platform="telegram")

        self.assertEqual(calls[0][0], "register")
        self.assertEqual(calls[1][0], "kv_set")
        self.assertEqual(calls[1][1]["key"], "config/work_tracker/work")
        tracker = json.loads(calls[1][1]["value"])
        self.assertEqual(tracker["identity"], "work")
        self.assertEqual(tracker["provider"], "linear")
        self.assertEqual(tracker["mcp"], "linear_work")
        self.assertEqual(tracker["team"], "ENG")

    def test_session_start_reports_herdr_agent_status_when_env_present(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"

        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            self.assertEqual(tool_suffix, "register")
            return {"id": "inst-session-123"}

        with (
            mock.patch.object(lifecycle, "_load_config", return_value={"swarm": {"role": "worker"}}),
            mock.patch.object(lifecycle, "_dispatch", side_effect=fake_dispatch),
            mock.patch("integrations.hermes.workspace_identity.publish_current_identity"),
            mock.patch.object(
                lifecycle.herdr_agent_report,
                "report_agent",
                return_value=True,
            ) as report_agent,
        ):
            lifecycle.on_session_start(session_id="session-123", platform="telegram")

        report_agent.assert_called_once_with(
            agent="hermes",
            state="idle",
            source="swarm-mcp:hermes:inst-session-123",
            message="swarm session registered",
        )

    def test_session_start_ignores_herdr_agent_report_exceptions(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"

        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            self.assertEqual(tool_suffix, "register")
            return {"id": "inst-session-123"}

        with (
            mock.patch.object(lifecycle, "_load_config", return_value={"swarm": {"role": "worker"}}),
            mock.patch.object(lifecycle, "_dispatch", side_effect=fake_dispatch),
            mock.patch("integrations.hermes.workspace_identity.publish_current_identity"),
            mock.patch.object(
                lifecycle.herdr_agent_report,
                "report_agent",
                side_effect=RuntimeError("socket unavailable"),
            ),
        ):
            lifecycle.on_session_start(session_id="session-123", platform="telegram")

        self.assertEqual(lifecycle.get_instance_id("session-123"), "inst-session-123")

    def test_session_finalize_releases_herdr_agent_when_env_present(self) -> None:
        os.environ["HERDR_PANE_ID"] = "pane-1"
        os.environ["HERDR_SOCKET_PATH"] = "/tmp/herdr.sock"
        lifecycle._instances["session-123"] = "inst-session-123"
        lifecycle._roles_by_session["session-123"] = "worker"
        lifecycle._refcounts["inst-session-123"] = 1

        with (
            mock.patch("integrations.hermes.workspace_identity.delete_current_identity"),
            mock.patch.object(lifecycle, "_dispatch", return_value={"ok": True}),
            mock.patch.object(
                lifecycle.herdr_agent_report,
                "release_agent",
                return_value=True,
            ) as release_agent,
        ):
            lifecycle.on_session_finalize(session_id="session-123")

        release_agent.assert_called_once_with(
            agent="hermes",
            source="swarm-mcp:hermes:inst-session-123",
        )

    def test_gateway_role_skips_pre_tool_lock_check(self) -> None:
        self._start_with_config({"swarm": {"role": "gateway"}})

        with mock.patch.object(lifecycle, "_peer_lock_holder", return_value=None) as peer_check:
            result = lifecycle.on_pre_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-123",
                tool_call_id="call-1",
            )

        self.assertIsNone(result)
        peer_check.assert_not_called()

    def test_worker_role_allows_write_when_no_peer_lock(self) -> None:
        self._start_with_config({"swarm": {"role": "worker"}})

        with mock.patch.object(lifecycle, "_peer_lock_holder", return_value=None) as peer_check:
            result = lifecycle.on_pre_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-123",
                tool_call_id="call-1",
            )

        self.assertIsNone(result)
        peer_check.assert_called_once_with(
            os.path.abspath("example.txt"), "inst-session-123"
        )

    def test_worker_role_blocks_write_when_peer_holds_lock(self) -> None:
        self._start_with_config({"swarm": {"role": "worker"}})

        peer_lock = {
            "owner": {"id": "inst-peer-xyz"},
            "content": "mid-refactor",
        }
        with mock.patch.object(lifecycle, "_peer_lock_holder", return_value=peer_lock):
            result = lifecycle.on_pre_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-123",
                tool_call_id="call-1",
            )

        self.assertIsInstance(result, dict)
        self.assertEqual(result["action"], "block")
        self.assertIn("swarm lock blocked write_file", result["message"])
        self.assertIn(os.path.abspath("example.txt"), result["message"])
        self.assertIn("inst-pee", result["message"])
        self.assertIn("mid-refactor", result["message"])

    def test_worker_role_passes_through_when_session_has_no_instance(self) -> None:
        with mock.patch.object(lifecycle, "_peer_lock_holder", return_value=None) as peer_check:
            result = lifecycle.on_pre_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-unknown",
                tool_call_id="call-1",
            )

        self.assertIsNone(result)
        peer_check.assert_not_called()

    def test_post_tool_call_is_a_noop(self) -> None:
        """Check-only model: nothing was acquired, so post-hook does nothing."""
        with mock.patch.object(lifecycle, "_dispatch") as dispatch:
            result = lifecycle.on_post_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-123",
                tool_call_id="call-1",
            )

        self.assertIsNone(result)
        dispatch.assert_not_called()

    def test_default_label_matches_shared_adapter_tokens(self) -> None:
        with mock.patch.object(lifecycle, "_load_config", return_value={"swarm": {"role": "gateway"}}):
            args = lifecycle._register_args("session-123", {"platform": "telegram"})

        self.assertIn("hermes", args["label"])
        self.assertIn("platform:telegram", args["label"])
        self.assertIn("mode:gateway", args["label"])
        self.assertIn("role:planner", args["label"])
        self.assertIn("origin:hermes", args["label"])
        self.assertIn("session:session1", args["label"])

    def test_patch_paths_are_absolute_and_include_moves(self) -> None:
        paths = lifecycle._paths_for_tool(
            "apply_patch",
            {
                "patch": """*** Begin Patch
*** Update File: src/a.txt
@@
-old
+new
*** Move File: src/b.txt -> src/c.txt
*** End Patch""",
            },
        )

        self.assertEqual(
            paths,
            [
                os.path.abspath("src/a.txt"),
                os.path.abspath("src/b.txt"),
                os.path.abspath("src/c.txt"),
            ],
        )


class SwarmStatusRoleTests(unittest.TestCase):
    def test_status_includes_plugin_role_and_preserves_instance_role_labels(self) -> None:
        payload = {
            "instances": [{"id": "abcdef123456", "label": "identity:personal role:implementer"}],
            "tasks": [],
            "kv": [],
            "messages": [],
        }

        rendered = cli._format_status(payload, role="gateway")

        self.assertIn("role      : gateway", rendered)
        self.assertIn("role:implementer", rendered)

    def test_handle_status_uses_cached_lifecycle_role(self) -> None:
        payload = {"instances": [], "tasks": [], "kv": [], "messages": []}

        with mock.patch.object(cli, "_run", return_value=(0, json.dumps(payload), "")), mock.patch(
            "integrations.hermes.lifecycle.get_role", return_value="gateway"
        ):
            rendered = cli.handle_slash("status")

        self.assertIn("role      : gateway", rendered)


if __name__ == "__main__":
    unittest.main()
