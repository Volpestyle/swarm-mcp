from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from integrations._shared import swarm_adapter_contract as contract


class SwarmAdapterContractTests(unittest.TestCase):
    def test_gateway_label_has_common_tokens(self) -> None:
        label = contract.build_label(
            contract.LabelConfig(
                runtime_name="hermes",
                env_prefix="HERMES",
                plugin_role="gateway",
                session_id="session-123",
                platform="telegram",
                identity="personal",
            )
        )

        self.assertEqual(
            label,
            "identity:personal hermes platform:telegram mode:gateway role:planner origin:hermes session:session1",
        )

    def test_override_label_gets_identity_and_session(self) -> None:
        label = contract.build_label(
            contract.LabelConfig(
                runtime_name="codex",
                env_prefix="CODEX",
                plugin_role="worker",
                session_id="abc-123",
                override_label="role:researcher topic:x",
                identity="work",
            )
        )

        self.assertEqual(label, "identity:work role:researcher topic:x session:abc123")

    def test_apply_patch_paths_are_absolute_deduped_and_include_moves(self) -> None:
        patch = """*** Begin Patch
*** Update File: src/a.txt
*** Move File: src/b.txt -> src/c.txt
*** Update File: src/a.txt
*** End Patch"""

        self.assertEqual(
            contract.apply_patch_paths(patch, os.getcwd),
            [
                os.path.abspath("src/a.txt"),
                os.path.abspath("src/b.txt"),
                os.path.abspath("src/c.txt"),
            ],
        )

    def test_resolved_herdr_socket_path_reads_profile_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir:
            for profile, socket in (
                ("personal", "/run/herdr-personal.sock"),
                ("work", "/run/herdr-work.sock"),
            ):
                with open(os.path.join(profile_dir, f"{profile}.env"), "w") as handle:
                    handle.write(f"HERDR_SOCKET_PATH={socket}\n")

            with mock.patch.dict(
                os.environ,
                {"SWARM_MCP_PROFILE_DIR": profile_dir},
                clear=True,
            ):
                self.assertEqual(
                    contract.resolved_herdr_socket_path("personal"),
                    "/run/herdr-personal.sock",
                )
                self.assertEqual(
                    contract.resolved_herdr_socket_path("work"),
                    "/run/herdr-work.sock",
                )

    def test_resolved_herdr_socket_path_honors_explicit_env(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"HERDR_SOCKET_PATH": "/custom/herdr.sock"},
            clear=True,
        ):
            self.assertEqual(
                contract.resolved_herdr_socket_path("personal"),
                "/custom/herdr.sock",
            )

    def test_resolved_herdr_socket_path_empty_when_no_profile_or_env(self) -> None:
        with tempfile.TemporaryDirectory() as profile_dir:
            with mock.patch.dict(
                os.environ,
                {"SWARM_MCP_PROFILE_DIR": profile_dir},
                clear=True,
            ):
                self.assertEqual(contract.resolved_herdr_socket_path("missing"), "")
                self.assertEqual(contract.resolved_herdr_socket_path(""), "")


if __name__ == "__main__":
    unittest.main()
