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

_IDENTITY_KEY_PREFIX = "identity/herdr/"


def identity_key(instance_id: str) -> str:
    return f"{_IDENTITY_KEY_PREFIX}{instance_id}"


def current_herdr_identity() -> dict[str, str]:
    pane_id = os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE")
    if not pane_id:
        return {}

    identity = {"pane_id": pane_id}
    socket_path = os.environ.get("HERDR_SOCKET_PATH")
    if socket_path:
        identity["socket_path"] = socket_path
    workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
    if workspace_id:
        identity["workspace_id"] = workspace_id
    return identity


def publish_current_identity(instance_id: str) -> None:
    identity = current_herdr_identity()
    if not identity:
        return

    payload = json.dumps(identity, separators=(",", ":"))
    result = lifecycle._extract_payload(  # same-package helper; keep MCP wrapping in one place.
        lifecycle._dispatch("kv_set", {"key": identity_key(instance_id), "value": payload})
    )
    if isinstance(result, dict) and result.get("error"):
        logger.debug("swarm plugin: failed to publish herdr identity: %s", result.get("error"))


def delete_current_identity(instance_id: str) -> None:
    result = lifecycle._extract_payload(
        lifecycle._dispatch("kv_delete", {"key": identity_key(instance_id)})
    )
    if isinstance(result, dict) and result.get("error"):
        logger.debug("swarm plugin: failed to delete herdr identity: %s", result.get("error"))


def _load_identity(recipient: str) -> tuple[dict[str, Any], str]:
    payload = lifecycle._extract_payload(
        lifecycle._dispatch("kv_get", {"key": identity_key(recipient)})
    )
    if not isinstance(payload, dict) or not isinstance(payload.get("value"), str):
        return {}, "no herdr identity is published for that instance"

    try:
        value = json.loads(payload["value"])
    except json.JSONDecodeError:
        return {}, "published herdr identity is not valid JSON"
    if not isinstance(value, dict):
        return {}, "published herdr identity is not an object"
    return value, ""


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
    if isinstance(socket_path, str) and socket_path:
        env["HERDR_SOCKET_PATH"] = socket_path
    return env


def _pane_status(identity: dict[str, Any]) -> tuple[str, str]:
    pane_id = identity.get("pane_id")
    if not isinstance(pane_id, str) or not pane_id:
        return "", "published herdr identity has no pane_id"
    if not shutil.which("herdr"):
        return "", "herdr CLI is not available"

    try:
        proc = subprocess.run(
            ["herdr", "pane", "get", pane_id],
            capture_output=True,
            text=True,
            timeout=5,
            env=_herdr_env(identity),
        )
    except Exception as exc:
        return "", f"herdr pane get failed: {exc}"

    if proc.returncode != 0:
        return "", (proc.stderr or proc.stdout or "herdr pane get failed").strip()

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return "", "herdr pane get returned non-JSON output"

    pane = payload.get("result", {}).get("pane") if isinstance(payload, dict) else None
    if not isinstance(pane, dict):
        return "", "herdr pane get returned no pane"
    status = pane.get("agent_status")
    return status if isinstance(status, str) else "unknown", ""


def _nudge(identity: dict[str, Any], prompt: str) -> tuple[bool, str]:
    pane_id = identity.get("pane_id")
    if not isinstance(pane_id, str) or not pane_id:
        return False, "published herdr identity has no pane_id"
    if not shutil.which("herdr"):
        return False, "herdr CLI is not available"

    try:
        proc = subprocess.run(
            ["herdr", "pane", "run", pane_id, prompt],
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
    """Send a durable swarm message and optionally wake the target pane."""
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

    identity, reason = _load_identity(recipient)
    if not identity:
        result["nudge_skipped"] = reason
        return json.dumps(result)

    status, status_error = _pane_status(identity)
    result["pane_id"] = identity.get("pane_id")
    result["agent_status"] = status or "unknown"
    if status_error:
        result["nudge_skipped"] = status_error
        return json.dumps(result)
    if status not in {"idle", "blocked", "done", "unknown"} and not force:
        result["nudge_skipped"] = f"target pane is {status}; pass force=true to inject anyway"
        return json.dumps(result)

    wake_prompt = (
        f"{sender_note}. Call the swarm poll_messages tool, handle the message, "
        "and report back through swarm-mcp."
    )
    ok, nudge_error = _nudge(identity, wake_prompt)
    result["nudged"] = ok
    if nudge_error:
        result["nudge_error"] = nudge_error
    return json.dumps(result)


SCHEMA = {
    "name": "swarm_prompt_peer",
    "description": (
        "Send a durable swarm message to another instance, then best-effort nudge "
        "its herdr pane if the target published a pane identity. Use this as an "
        "express lane; swarm-mcp remains the source of truth."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "recipient": {"type": "string", "description": "Target swarm instance id."},
            "message": {"type": "string", "description": "Instruction to send through swarm."},
            "task_id": {"type": "string", "description": "Optional related swarm task id."},
            "nudge": {
                "type": "boolean",
                "description": "Whether to wake the target herdr pane after sending the message.",
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
