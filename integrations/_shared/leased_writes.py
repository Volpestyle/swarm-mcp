"""Opt-in coordinator leases for known write hooks and explicit critical sections.

This is cooperative host enforcement, not an operating-system filesystem lock.
The launcher supplies an argv JSON client command and session credentials in env.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from uuid import uuid4


def enabled() -> bool:
    return bool(os.environ.get("SWARM_COORDINATOR_CLIENT"))


def request(operation: dict) -> dict:
    argv = json.loads(os.environ["SWARM_COORDINATOR_CLIENT"])
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x for x in argv):
        raise RuntimeError("SWARM_COORDINATOR_CLIENT must be an argv JSON array")
    result = subprocess.run(argv, input=json.dumps(operation), text=True, capture_output=True, timeout=12)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Coordinator request failed")
    response = json.loads(result.stdout)
    return response


def command(kind: str, payload: dict, command_id: str | None = None) -> dict:
    return request({"op": "command", "command": {"id": command_id or str(uuid4()), "type": kind, "payload": payload}})["value"]


def refs(grants: list[dict]) -> list[dict]:
    return [{"id": grant["id"], "fence": grant["fence"]} for grant in grants]


def acquire(paths: list[str], reason: str, command_id: str | None = None, kind: str = "file") -> dict:
    payload = {"kind": kind, "paths": paths, "reason": reason, "leaseMs": 60000}
    attempt = os.environ.get("SWARM_TASK_ATTEMPT_ID")
    if attempt:
        payload["attemptId"] = attempt
    result = command("reservation.acquire", payload, command_id)
    if not result.get("acquired"):
        conflicts = result.get("conflicts", [])
        owners = "; ".join(f"{r['resource']} held by {r['actor']} ({r['reason']}), age {r['ageMs']}ms, expires {r['expires_at']}" for r in conflicts)
        raise RuntimeError(f"Reservation conflict: {owners}. Wait for release/expiry or recover the stale holder; retry with a new tool call ID.")
    grants = result["grants"] + result["reused"]
    # A replayed acquisition is not a fresh lease. Check the current fence before
    # allowing the host to perform the write.
    command("reservation.check", {"grants": refs(grants)})
    return result


def release(result: dict, command_id: str | None = None) -> None:
    if result.get("grants"):
        command("reservation.release", {"grants": refs(result["grants"])}, command_id)


def state_path(payload: dict) -> Path:
    call_id = payload.get("tool_use_id") or payload.get("tool_call_id")
    session_id = payload.get("session_id")
    if not call_id or not session_id:
        raise RuntimeError("Leased writes require stable session_id and tool_use_id/tool_call_id from the host")
    # The capability hash partitions host sessions after adoption, without
    # persisting the capability itself or trusting path characters in hook input.
    key = hashlib.sha256(json.dumps([session_id, call_id, os.environ.get("SWARM_SESSION_CAPABILITY", "")]).encode()).hexdigest()
    directory = Path(tempfile.gettempdir()) / "swarm-coordinator-write-leases"
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory / f"{key}.json"


def enter(payload: dict, paths: list[str]) -> dict:
    if not paths:
        raise RuntimeError("Known write tool supplied no recognizable paths; reservation coverage is unavailable")
    path = state_path(payload)
    result = acquire(paths, f"{payload.get('tool_name', 'write')} tool call", f"hook-acquire-{path.stem}")
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(result), encoding="utf-8")
    os.replace(temporary, path)
    return result


def leave(payload: dict) -> None:
    path = state_path(payload)
    if not path.exists():
        return
    result = json.loads(path.read_text(encoding="utf-8"))
    release(result, f"hook-release-{path.stem}")
    path.unlink(missing_ok=True)
