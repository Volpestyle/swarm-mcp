#!/usr/bin/env python3
"""SessionStart hook -- prime the agent to register with swarm-mcp.

Claude Code does not expose dynamic tool registration to plugins, so we cannot
literally call the swarm ``register`` MCP tool from here. Instead we:

1. Compute the canonical label/scope/file_root the way hermes does.
2. Stash them in a per-session scratch file so PreToolUse/PostToolUse can use
   the same ``session:<short>`` selector when shelling to ``swarm-mcp lock``.
3. Emit ``additionalContext`` that tells the agent to call ``register`` with
   exactly those args on its first turn. The bundled ``swarm-mcp`` skill
   already drives registration; this just removes the boilerplate of figuring
   out the right label/scope/identity.

Failures are silent. Coordination is opt-in convenience.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common  # noqa: E402


def _build_context(session_id: str, cwd: str) -> str:
    label = _common.derived_label(session_id)
    scope = _common.scope_arg()
    file_root = _common.file_root_arg()

    register_args: dict[str, str] = {"directory": cwd or _common.session_cwd(), "label": label}
    if scope:
        register_args["scope"] = scope
    if file_root:
        register_args["file_root"] = file_root

    pretty = json.dumps(register_args, indent=2)
    lines = [
        "## swarm coordination is available",
        "",
        "Call the `register` tool from the `swarm` MCP server early in this session.",
        "Use exactly these args so peer locks and `/swarm` can resolve your identity:",
        "",
        "```json",
        pretty,
        "```",
        "",
        "After registering, follow the `swarm-mcp` skill: `whoami`, `list_instances`,",
        "`poll_messages`, `list_tasks`, then act on any pending work.",
    ]

    herdr_pane = os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE")
    if herdr_pane:
        identity_payload: dict[str, str] = {"pane_id": herdr_pane}
        socket_path = os.environ.get("HERDR_SOCKET_PATH")
        if socket_path:
            identity_payload["socket_path"] = socket_path
        workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
        if workspace_id:
            identity_payload["workspace_id"] = workspace_id
        identity_blob = json.dumps(identity_payload, separators=(",", ":"))
        lines.extend(
            [
                "",
                "After `register` returns your `instance_id`, also publish your herdr",
                "pane handle so peers can wake you with `swarm_prompt_peer`-style flows:",
                "",
                "```text",
                f'kv_set key="identity/herdr/<your_instance_id>" value=\'{identity_blob}\'',
                "```",
            ]
        )

    return "\n".join(lines)


def main() -> int:
    payload = _common.read_hook_input(sys.stdin)
    session_id = str(payload.get("session_id") or "")
    cwd = str(payload.get("cwd") or _common.session_cwd())
    source = str(payload.get("source") or "startup")

    label = _common.derived_label(session_id)
    _common.write_session_meta(
        session_id,
        {
            "label": label,
            "session_short": _common.session_short(session_id),
            "scope": _common.scope_arg() or "",
            "file_root": _common.file_root_arg() or "",
            "cwd": cwd,
            "herdr_pane_id": os.environ.get("HERDR_PANE_ID")
            or os.environ.get("HERDR_PANE")
            or "",
        },
    )

    # Resume/clear/compact reuse an existing session that already registered;
    # don't re-prompt registration in that case.
    if source not in {"startup", "resume"} or not session_id:
        return 0

    context = _build_context(session_id, cwd)
    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Fail open: never block a session over coordination glue.
        sys.exit(0)
