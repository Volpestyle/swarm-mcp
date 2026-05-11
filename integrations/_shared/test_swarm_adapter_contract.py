from __future__ import annotations

import os
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

    def test_personal_herdr_socket_prefers_host_volpestyle_root(self) -> None:
        with mock.patch.dict(
            os.environ,
            {
                "HERMES_HOST_HOME": "/Users/james.volpe",
                "HOME": "/sandbox/home",
            },
            clear=True,
        ):
            self.assertEqual(
                contract.resolved_herdr_socket_path("personal"),
                os.path.abspath(
                    "/Users/james.volpe/volpestyle/.herdr/personal/herdr.sock"
                ),
            )

    def test_work_identity_gets_separate_host_herdr_socket_default(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"HERMES_HOST_HOME": "/Users/james.volpe", "HOME": "/sandbox/home"},
            clear=True,
        ):
            self.assertEqual(
                contract.resolved_herdr_socket_path("work"),
                os.path.abspath("/Users/james.volpe/.herdr/work/herdr.sock"),
            )


if __name__ == "__main__":
    unittest.main()
