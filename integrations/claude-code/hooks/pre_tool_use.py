#!/usr/bin/env python3
"""PreToolUse hook -- auto-acquire swarm locks when peers exist.

Mirrors the hermes plugin's lock bridge:

- If no peers in scope, do nothing (matches the skill's "skip locking when alone"
  guidance and keeps solo sessions zero-overhead).
- For each path the write-class tool will touch, call ``swarm-mcp lock``.
- If a real peer holds the lock, deny the tool call. Other failures fail open.

Failure modes (non-conflict): missing CLI, network/db error, unresolvable
identity. We log nothing visible -- coordination is opt-in convenience and
should never block productive tool calls.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common  # noqa: E402


def _looks_like_lock_conflict(stdout: str, stderr: str) -> bool:
    blob = f"{stdout}\n{stderr}".lower()
    return "locked" in blob or "lock conflict" in blob


def _lock_one(path: str, selector: str | None, scope: str | None) -> tuple[bool, str]:
    args = ["lock", path, "--note", "claude-code auto-lock before write"]
    if selector:
        args.extend(["--as", selector])
    if scope:
        args.extend(["--scope", scope])
    rc, out, err = _common.run_swarm(args, timeout=6.0)
    if rc == 0:
        return True, ""
    if _looks_like_lock_conflict(out, err):
        return False, (err.strip() or out.strip() or "File is already locked")
    # Fail open on other errors.
    return True, ""


def _release(paths: list[str], selector: str | None, scope: str | None) -> None:
    for path in reversed(paths):
        args = ["unlock", path]
        if selector:
            args.extend(["--as", selector])
        if scope:
            args.extend(["--scope", scope])
        _common.run_swarm(args, timeout=4.0)


def main() -> int:
    payload = _common.read_hook_input(sys.stdin)
    tool_name = str(payload.get("tool_name") or "")
    if tool_name not in _common.WRITE_TOOLS:
        return 0

    tool_input = payload.get("tool_input") or {}
    paths = _common.write_paths_for_tool(tool_name, tool_input)
    if not paths:
        return 0

    session_id = str(payload.get("session_id") or "")
    meta = _common.read_session_meta(session_id)
    scope = meta.get("scope") or _common.scope_arg()

    if not _common.has_peers(scope, session_id):
        return 0

    selector = _common.as_selector(session_id)
    acquired: list[str] = []
    for path in paths:
        ok, message = _lock_one(path, selector, scope)
        if not ok:
            _release(acquired, selector, scope)
            _common.emit_block(
                f"swarm lock blocked {tool_name} for {path}: {message}"
            )
            return 0
        acquired.append(path)

    if acquired:
        _common.record_locks(
            session_id, _common.lock_key(tool_name, tool_input), acquired
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
