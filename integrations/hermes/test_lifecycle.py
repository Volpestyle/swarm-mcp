from __future__ import annotations

import json
import logging
import os
import unittest
from unittest import mock

from integrations.hermes import cli, lifecycle


class SwarmRoleConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env = mock.patch.dict(os.environ, {}, clear=True)
        self._env.start()
        lifecycle._instances.clear()
        lifecycle._refcounts.clear()
        lifecycle._locks_by_call.clear()
        if hasattr(lifecycle, "_roles_by_session"):
            lifecycle._roles_by_session.clear()

    def tearDown(self) -> None:
        self._env.stop()
        lifecycle._instances.clear()
        lifecycle._refcounts.clear()
        lifecycle._locks_by_call.clear()
        if hasattr(lifecycle, "_roles_by_session"):
            lifecycle._roles_by_session.clear()

    def _start_with_config(self, config: dict, session_id: str = "session-123") -> None:
        def fake_dispatch(tool_suffix: str, args: dict) -> dict:
            self.assertEqual(tool_suffix, "register")
            return {"id": f"inst-{session_id}"}

        with mock.patch.object(lifecycle, "_load_config", return_value=config), mock.patch.object(
            lifecycle, "_dispatch", side_effect=fake_dispatch
        ), mock.patch("integrations.hermes.prompt_peer.publish_current_identity"):
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
        ), mock.patch("integrations.hermes.prompt_peer.publish_current_identity"):
            lifecycle.on_session_start(session_id="session-123", platform="telegram")

        self.assertEqual(calls[0][0], "register")
        self.assertEqual(calls[1][0], "kv_set")
        self.assertEqual(calls[1][1]["key"], "config/work_tracker/work")
        tracker = json.loads(calls[1][1]["value"])
        self.assertEqual(tracker["identity"], "work")
        self.assertEqual(tracker["provider"], "linear")
        self.assertEqual(tracker["mcp"], "linear_work")
        self.assertEqual(tracker["team"], "ENG")

    def test_gateway_role_skips_pre_tool_lock_bridge(self) -> None:
        self._start_with_config({"swarm": {"role": "gateway"}})

        with mock.patch.object(lifecycle, "_has_peers", return_value=True) as has_peers, mock.patch.object(
            lifecycle, "_lock_file", return_value=(True, "")
        ) as lock_file:
            result = lifecycle.on_pre_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-123",
                tool_call_id="call-1",
            )

        self.assertIsNone(result)
        has_peers.assert_not_called()
        lock_file.assert_not_called()

    def test_worker_role_keeps_pre_tool_lock_bridge(self) -> None:
        self._start_with_config({"swarm": {"role": "worker"}})

        with mock.patch.object(lifecycle, "_has_peers", return_value=True), mock.patch.object(
            lifecycle, "_lock_file", return_value=(True, "")
        ) as lock_file:
            result = lifecycle.on_pre_tool_call(
                tool_name="write_file",
                args={"path": "example.txt"},
                session_id="session-123",
                tool_call_id="call-1",
            )

        self.assertIsNone(result)
        lock_file.assert_called_once_with(os.path.abspath("example.txt"), "write_file")

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
