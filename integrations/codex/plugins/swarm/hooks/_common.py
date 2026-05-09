"""Codex-specific HookCore wiring.

The runtime-agnostic core lives in ``integrations/_shared/swarm_hook_core.py``;
this file just supplies the codex-flavored ``RuntimeConfig`` (label token,
env-var prefix, scratch dir, write-tool set, and the ``apply_patch`` envelope
parser) and exposes a singleton ``core`` for the entry scripts to call.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

# integrations/codex/plugins/swarm/hooks/_common.py -> parents[4] = integrations/
_INTEGRATIONS_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(_INTEGRATIONS_ROOT / "_shared"))

from swarm_hook_core import HookCore, RuntimeConfig  # noqa: E402


_PATCH_PATH_RE = re.compile(
    r"^\*\*\*\s+(Update|Add|Delete)\s+File:\s*(.+?)\s*$",
    re.MULTILINE,
)
_PATCH_MOVE_RE = re.compile(
    r"^\*\*\*\s+Move\s+File:\s*(.+?)\s*->\s*(.+?)\s*$",
    re.MULTILINE,
)


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
    if not p:
        return ""
    if os.path.isabs(p):
        return p
    return os.path.abspath(os.path.join(HookCore.session_cwd(), p))


def _extract_paths(_tool_name: str, tool_input: object) -> list[str]:
    patch = _patch_text_from_input(tool_input)
    if not patch:
        return []

    seen: set[str] = set()
    out: list[str] = []

    def push(value: str | None) -> None:
        if not value:
            return
        abs_p = _abs_path(value.strip())
        if abs_p and abs_p not in seen:
            seen.add(abs_p)
            out.append(abs_p)

    for match in _PATCH_PATH_RE.finditer(patch):
        push(match.group(2))
    for match in _PATCH_MOVE_RE.finditer(patch):
        push(match.group(1))
        push(match.group(2))

    return out


core = HookCore(
    RuntimeConfig(
        runtime_name="codex",
        env_prefix="CODEX",
        scratch_dir_name="swarm-codex",
        write_tools=frozenset({"apply_patch"}),
        extract_paths=_extract_paths,
        auto_lock_note="codex auto-lock before apply_patch",
    )
)
