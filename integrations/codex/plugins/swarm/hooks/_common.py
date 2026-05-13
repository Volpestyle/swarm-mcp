"""Codex-specific HookCore wiring.

The runtime-agnostic core lives in ``integrations/_shared/swarm_hook_core.py``;
this file just supplies the codex-flavored ``RuntimeConfig`` (label token,
env-var prefix, scratch dir, write-tool set, and the ``apply_patch`` envelope
parser) and exposes a singleton ``core`` for the entry scripts to call.
"""

from __future__ import annotations

import sys
from pathlib import Path

# integrations/codex/plugins/swarm/hooks/_common.py
_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
_INTEGRATIONS_ROOT = _PLUGIN_ROOT.parents[2]
sys.path.insert(0, str(_INTEGRATIONS_ROOT / "_shared"))

import swarm_adapter_contract as contract  # noqa: E402
from swarm_hook_core import HookCore, RuntimeConfig  # noqa: E402


def _patch_text_from_input(tool_input: object) -> str:
    """Pull the apply_patch envelope out of tool_input.

    Codex hasn't published a hard hook payload schema, so we accept several
    plausible shapes: the input may be the patch string itself, or a dict
    with the patch under ``input``, ``patch``, ``text``, or ``arguments``.
    """
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, dict):
        for key in ("input", "patch", "text", "arguments"):
            value = tool_input.get(key)
            if isinstance(value, str) and "*** Begin Patch" in value:
                return value
        for value in tool_input.values():
            if isinstance(value, str) and "*** Begin Patch" in value:
                return value
    return ""


def _abs_path(p: str) -> str:
    return contract.abs_path(p, HookCore.session_cwd)


def _extract_paths(_tool_name: str, tool_input: object) -> list[str]:
    patch = _patch_text_from_input(tool_input)
    if not patch:
        return []

    return contract.apply_patch_paths(patch, HookCore.session_cwd)


core = HookCore(
    RuntimeConfig(
        runtime_name="codex",
        env_prefix="CODEX",
        scratch_dir_name="swarm-codex",
        write_tools=frozenset({"apply_patch"}),
        extract_paths=_extract_paths,
        soul_path=_PLUGIN_ROOT / "SOUL.md",
    )
)
