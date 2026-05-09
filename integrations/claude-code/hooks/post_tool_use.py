#!/usr/bin/env python3
"""PostToolUse hook -- release any locks PreToolUse acquired.

PreToolUse stores the locked paths under a key derived from the tool name and
its target paths; we read the same key here. ``unlock`` is idempotent enough
that we don't need a tool_call_id to disambiguate.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common  # noqa: E402


def main() -> int:
    payload = _common.read_hook_input(sys.stdin)
    tool_name = str(payload.get("tool_name") or "")
    if tool_name not in _common.WRITE_TOOLS:
        return 0

    tool_input = payload.get("tool_input") or {}
    session_id = str(payload.get("session_id") or "")
    if not session_id:
        return 0

    key = _common.lock_key(tool_name, tool_input)
    paths = list(_common.iter_locked_paths(session_id, key))
    if not paths:
        return 0

    meta = _common.read_session_meta(session_id)
    scope = meta.get("scope") or _common.scope_arg()
    selector = _common.as_selector(session_id)

    for path in reversed(paths):
        args = ["unlock", path]
        if selector:
            args.extend(["--as", selector])
        if scope:
            args.extend(["--scope", scope])
        _common.run_swarm(args, timeout=4.0)

    _common.clear_locks(session_id, key)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
