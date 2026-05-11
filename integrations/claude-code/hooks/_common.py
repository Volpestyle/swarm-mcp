"""Claude-Code-specific HookCore wiring.

The runtime-agnostic core lives in ``integrations/_shared/swarm_hook_core.py``;
this file just supplies the Claude-Code-flavored ``RuntimeConfig`` (label
token, env-var prefix, scratch dir, write-tool set, and the ``file_path``-style
path extractor) and exposes a singleton ``core`` for the entry scripts to
call.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# integrations/claude-code/hooks/_common.py -> parents[2] = integrations/
_INTEGRATIONS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_INTEGRATIONS_ROOT / "_shared"))

from swarm_hook_core import HookCore, RuntimeConfig  # noqa: E402


_WRITE_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})


def _abs_path(p: str) -> str:
    if not p:
        return ""
    if os.path.isabs(p):
        return p
    return os.path.abspath(os.path.join(HookCore.session_cwd(), p))


def _extract_paths(tool_name: str, tool_input: object) -> list[str]:
    if not isinstance(tool_input, dict):
        return []

    seen: set[str] = set()
    out: list[str] = []

    def push(value: object) -> None:
        if isinstance(value, str) and value:
            abs_p = _abs_path(value)
            if abs_p and abs_p not in seen:
                seen.add(abs_p)
                out.append(abs_p)

    if tool_name in {"Write", "Edit", "MultiEdit"}:
        push(tool_input.get("file_path"))
    elif tool_name == "NotebookEdit":
        push(tool_input.get("notebook_path"))

    for key in ("path", "file", "filepath"):
        push(tool_input.get(key))

    return out


core = HookCore(
    RuntimeConfig(
        runtime_name="claude-code",
        env_prefix="CC",
        scratch_dir_name="swarm-cc",
        write_tools=_WRITE_TOOLS,
        extract_paths=_extract_paths,
    )
)
