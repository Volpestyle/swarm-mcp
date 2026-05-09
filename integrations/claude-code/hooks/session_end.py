#!/usr/bin/env python3
"""SessionEnd hook -- cleanup the session's herdr identity KV and scratch dir.

The swarm-mcp CLI does not expose ``deregister``; the agent itself, or
swarm-mcp's stale-instance prune, owns that. We do clean up:

1. ``identity/herdr/<instance_id>`` if we know our instance id (best-effort
   resolution from the swarm via the session-short label substring).
2. The plugin's per-session scratch dir.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _common  # noqa: E402


def _resolve_instance_id(session_id: str, scope: str | None) -> str | None:
    short = _common.session_short(session_id)
    if not short:
        return None
    args = ["instances", "--json"]
    if scope:
        args.extend(["--scope", scope])
    rc, out, _ = _common.run_swarm(args, timeout=4.0)
    if rc != 0:
        return None
    marker = f"session:{short}"
    for inst in _common.parse_instances_json(out):
        label = " ".join(
            str(inst.get(k) or "") for k in ("label", "labels", "role", "name")
        )
        if marker in label:
            inst_id = inst.get("id") or inst.get("instance_id")
            if isinstance(inst_id, str) and inst_id:
                return inst_id
    return None


def main() -> int:
    payload = _common.read_hook_input(sys.stdin)
    session_id = str(payload.get("session_id") or "")
    meta = _common.read_session_meta(session_id)
    scope = meta.get("scope") or _common.scope_arg()

    instance_id = _resolve_instance_id(session_id, scope)
    if instance_id:
        kv_args = ["kv", "del", f"identity/herdr/{instance_id}", "--as", instance_id]
        if scope:
            kv_args.extend(["--scope", scope])
        _common.run_swarm(kv_args, timeout=4.0)

    if session_id:
        try:
            shutil.rmtree(_common.session_scratch(session_id), ignore_errors=True)
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
