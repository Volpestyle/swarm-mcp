"""Express-lane peer prompting for swarm-aware Hermes sessions.

The durable instruction always goes through swarm-mcp first.  Herdr input is
only a best-effort wake-up for workers that are known to live in a pane.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from typing import Any

from . import lifecycle

logger = logging.getLogger(__name__)

_WORKSPACE_IDENTITY_KEY_PREFIX = "identity/workspace/herdr/"
_LEGACY_IDENTITY_KEY_PREFIX = "identity/herdr/"


def identity_key(instance_id: str) -> str:
    return f"{_WORKSPACE_IDENTITY_KEY_PREFIX}{instance_id}"


def identity_keys(instance_id: str) -> list[str]:
    return [identity_key(instance_id), f"{_LEGACY_IDENTITY_KEY_PREFIX}{instance_id}"]


def current_herdr_identity() -> dict[str, Any]:
    pane_id = os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE")
    if not pane_id:
        return {}

    identity: dict[str, Any] = {
        "schema_version": 1,
        "backend": "herdr",
        "handle_kind": "pane",
        "handle": pane_id,
        "pane_id": pane_id,
    }
    socket_path = lifecycle.contract.resolved_herdr_socket_path(lifecycle._identity_name())
    if socket_path:
        identity["socket_path"] = socket_path
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    if workspace_id:
        identity["workspace_id"] = workspace_id
    return _canonicalize_identity(identity, pane_id)


def _candidate_handles(identity: dict[str, Any]) -> list[str]:
    raw = [identity.get("handle"), identity.get("pane_id")]
    for key in ["handle_aliases", "pane_aliases"]:
        aliases = identity.get(key)
        if isinstance(aliases, list):
            raw.extend(aliases)
    seen: set[str] = set()
    result: list[str] = []
    for item in raw:
        if isinstance(item, str) and item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _herdr_bin() -> str:
    configured = os.environ.get("SWARM_HERDR_BIN")
    if configured:
        return configured
    return shutil.which("herdr") or ""


def _canonicalize_identity(identity: dict[str, Any], requested_pane_id: str) -> dict[str, Any]:
    herdr_bin = _herdr_bin()
    if not herdr_bin:
        return identity
    try:
        proc = subprocess.run(
            [herdr_bin, "pane", "get", requested_pane_id],
            capture_output=True,
            text=True,
            timeout=5,
            env=_herdr_env(identity),
        )
    except Exception:
        return identity
    if proc.returncode != 0:
        return identity

    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return identity
    pane = payload.get("result", {}).get("pane") if isinstance(payload, dict) else None
    if not isinstance(pane, dict):
        return identity

    canonical = pane.get("pane_id") or pane.get("id") or requested_pane_id
    if not isinstance(canonical, str) or not canonical:
        return identity

    next_identity = dict(identity)
    aliases = [
        item
        for item in [
            *(_candidate_handles(identity)[1:]),
            identity.get("handle") if identity.get("handle") != canonical else None,
            identity.get("pane_id") if identity.get("pane_id") != canonical else None,
            requested_pane_id if requested_pane_id != canonical else None,
        ]
        if isinstance(item, str) and item
    ]
    next_identity["backend"] = "herdr"
    next_identity["handle_kind"] = "pane"
    next_identity["handle"] = canonical
    next_identity["pane_id"] = canonical
    if aliases:
        unique_aliases = sorted(set(aliases))
        next_identity["handle_aliases"] = unique_aliases
        next_identity["pane_aliases"] = unique_aliases
    workspace_id = pane.get("workspace_id")
    if isinstance(workspace_id, str) and workspace_id:
        next_identity["workspace_id"] = workspace_id
    tab_id = pane.get("tab_id")
    if isinstance(tab_id, str) and tab_id:
        next_identity["tab_id"] = tab_id
    return next_identity


def publish_current_identity(instance_id: str) -> None:
    identity = current_herdr_identity()
    if not identity:
        return

    payload = json.dumps(identity, separators=(",", ":"))
    for key in identity_keys(instance_id):
        result = lifecycle._extract_payload(  # same-package helper; keep MCP wrapping in one place.
            lifecycle._dispatch("kv_set", {"key": key, "value": payload})
        )
        if isinstance(result, dict) and result.get("error"):
            logger.debug("swarm plugin: failed to publish workspace identity: %s", result.get("error"))


def delete_current_identity(instance_id: str) -> None:
    for key in identity_keys(instance_id):
        result = lifecycle._extract_payload(
            lifecycle._dispatch("kv_delete", {"key": key})
        )
        if isinstance(result, dict) and result.get("error"):
            logger.debug("swarm plugin: failed to delete workspace identity: %s", result.get("error"))


def _load_identity(recipient: str) -> tuple[dict[str, Any], str, str]:
    payload: Any = None
    matched_key = ""
    for key in identity_keys(recipient):
        payload = lifecycle._extract_payload(lifecycle._dispatch("kv_get", {"key": key}))
        if isinstance(payload, dict) and isinstance(payload.get("value"), str):
            matched_key = key
            break
    if not matched_key:
        return {}, "no workspace identity is published for that instance", ""

    try:
        value = json.loads(payload["value"])
    except json.JSONDecodeError:
        return {}, "published workspace identity is not valid JSON", matched_key
    if not isinstance(value, dict):
        return {}, "published workspace identity is not an object", matched_key
    return value, "", matched_key


def _content_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            return block["text"]
    return ""


def _herdr_env(identity: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()
    socket_path = identity.get("socket_path")
    if not isinstance(socket_path, str) or not socket_path:
        socket_path = lifecycle.contract.resolved_herdr_socket_path(lifecycle._identity_name())
    if isinstance(socket_path, str) and socket_path:
        env["HERDR_SOCKET_PATH"] = socket_path
    return env


def _pane_status(identity: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    pane_ids = _candidate_handles(identity)
    if not pane_ids:
        return "", "published workspace identity has no handle", identity
    herdr_bin = _herdr_bin()
    if not herdr_bin:
        return "", "herdr CLI is not available", identity

    last_error = ""
    for pane_id in pane_ids:
        try:
            proc = subprocess.run(
                [herdr_bin, "pane", "get", pane_id],
                capture_output=True,
                text=True,
                timeout=5,
                env=_herdr_env(identity),
            )
        except Exception as exc:
            last_error = f"herdr pane get failed: {exc}"
            continue

        if proc.returncode != 0:
            last_error = (proc.stderr or proc.stdout or "herdr pane get failed").strip()
            continue

        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            last_error = "herdr pane get returned non-JSON output"
            continue

        pane = payload.get("result", {}).get("pane") if isinstance(payload, dict) else None
        if not isinstance(pane, dict):
            last_error = "herdr pane get returned no pane"
            continue
        status = pane.get("agent_status")
        return (
            status if isinstance(status, str) else "unknown",
            "",
            _canonicalize_identity(identity, pane_id),
        )
    return "", last_error or "herdr pane get failed", identity


def _nudge(identity: dict[str, Any], prompt: str) -> tuple[bool, str]:
    pane_id = identity.get("pane_id")
    if not isinstance(pane_id, str) or not pane_id:
        return False, "published workspace identity has no handle"
    herdr_bin = _herdr_bin()
    if not herdr_bin:
        return False, "herdr CLI is not available"

    try:
        proc = subprocess.run(
            [herdr_bin, "pane", "run", pane_id, prompt],
            capture_output=True,
            text=True,
            timeout=5,
            env=_herdr_env(identity),
        )
    except Exception as exc:
        return False, f"herdr pane run failed: {exc}"

    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "herdr pane run failed").strip()
    return True, ""


def prompt_peer(args: dict[str, Any], **_: Any) -> str:
    """Send a durable swarm message and optionally wake the target workspace handle."""
    recipient = str(args.get("recipient") or args.get("recipient_instance_id") or "").strip()
    message = str(args.get("message") or args.get("prompt") or "").strip()
    if not recipient:
        return json.dumps({"error": "recipient is required"})
    if not message:
        return json.dumps({"error": "message is required"})

    task_id = str(args.get("task_id") or "").strip()
    nudge = bool(args.get("nudge", True))
    force = bool(args.get("force", False))
    sender_note = "A peer sent you a swarm message"
    if task_id:
        sender_note += f" for task {task_id}"

    durable_message = message
    if task_id:
        durable_message = f"[task:{task_id}] {message}"

    send_result = lifecycle._extract_payload(
        lifecycle._dispatch("send_message", {"recipient": recipient, "content": durable_message})
    )
    if send_result is None:
        return json.dumps({"error": "send_message failed"})
    if isinstance(send_result, dict) and send_result.get("error"):
        return json.dumps({"error": send_result.get("error")})
    send_text = _content_text(send_result)
    if send_text and "message sent" not in send_text.lower():
        return json.dumps({"error": send_text})

    result: dict[str, Any] = {
        "message_sent": True,
        "recipient": recipient,
        "nudged": False,
    }
    if not nudge:
        result["nudge_skipped"] = "nudge=false"
        return json.dumps(result)

    identity, reason, identity_key_used = _load_identity(recipient)
    if not identity:
        result["nudge_skipped"] = reason
        return json.dumps(result)

    status, status_error, resolved_identity = _pane_status(identity)
    result["workspace_backend"] = "herdr"
    result["workspace_handle"] = resolved_identity.get("handle") or resolved_identity.get("pane_id")
    result["pane_id"] = resolved_identity.get("pane_id")
    result["agent_status"] = status or "unknown"
    if status_error:
        result["nudge_skipped"] = status_error
        return json.dumps(result)
    if resolved_identity != identity:
        payload = json.dumps(resolved_identity, separators=(",", ":"))
        lifecycle._dispatch("kv_set", {"key": identity_key_used, "value": payload})
        result["identity_repaired"] = True
    if status not in {"idle", "blocked", "done", "unknown"} and not force:
        result["nudge_skipped"] = f"target workspace handle is {status}; pass force=true to inject anyway"
        return json.dumps(result)

    wake_prompt = (
        f"{sender_note}. Call the swarm poll_messages tool, handle the message, "
        "and report back through swarm-mcp."
    )
    ok, nudge_error = _nudge(resolved_identity, wake_prompt)
    result["nudged"] = ok
    if nudge_error:
        result["nudge_error"] = nudge_error
    return json.dumps(result)


SCHEMA = {
    "name": "swarm_prompt_peer",
    "description": (
        "Send a durable swarm message to another instance, then best-effort nudge "
        "its published workspace handle when a backend identity is available. "
        "Use this as an express lane; swarm-mcp remains the source of truth."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "recipient": {"type": "string", "description": "Target swarm instance id."},
            "message": {"type": "string", "description": "Instruction to send through swarm."},
            "task_id": {"type": "string", "description": "Optional related swarm task id."},
            "nudge": {
                "type": "boolean",
                "description": "Whether to wake the target workspace handle after sending the message.",
                "default": True,
            },
            "force": {
                "type": "boolean",
                "description": "Inject into a working pane too. Defaults to false to avoid interruption.",
                "default": False,
            },
        },
        "required": ["recipient", "message"],
    },
}
