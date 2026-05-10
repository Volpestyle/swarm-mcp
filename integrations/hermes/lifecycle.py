"""Session lifecycle bridge.

Auto-register on session start, auto-deregister on session finalization.
Failures are logged and swallowed -- swarm coordination is opt-in convenience,
not critical path. The agent can still call register/deregister itself if the
plugin's call fails.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from json import JSONDecoder
from pathlib import Path
from typing import Any, Dict, Optional

_INTEGRATIONS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_INTEGRATIONS_ROOT / "_shared"))

import swarm_adapter_contract as contract  # noqa: E402

logger = logging.getLogger(__name__)


# Per-session instance state. Keyed by session_id; cleared on session finalize.
# Guarded because hermes runs gateway turns in worker threads.
_instances: Dict[str, str] = {}
_roles_by_session: Dict[str, str] = {}
_refcounts: Dict[str, int] = {}
_locks_by_call: Dict[str, list[str]] = {}
_lock = threading.Lock()
_json_decoder = JSONDecoder()
_WRITE_TOOLS = {"write_file", "patch", "edit_file", "apply_patch"}
_VALID_PLUGIN_ROLES = {"worker", "gateway"}
_warned_missing_identity = False


def _resolved_identity() -> str:
    """Return the identity for label/registration, falling back to ``unknown``.

    Hermes sessions launched without an identity wrapper (raw ``hermes`` instead
    of ``hermesp``/``hermesw``) miss ``AGENT_IDENTITY`` and would otherwise
    register without any ``identity:`` token. Cross-identity boundary checks
    fail-open on missing identities, so an unlabeled instance is discoverable
    from any identity — defeating the boundary. We substitute ``unknown`` so the
    label always carries a distinct, non-work/non-personal identity token, then
    warn the operator once so they can fix the launcher.
    """
    global _warned_missing_identity
    raw = (
        os.environ.get("SWARM_HERMES_IDENTITY")
        or os.environ.get("AGENT_IDENTITY")
        or os.environ.get("SWARM_IDENTITY")
        or ""
    )
    derived = contract.identity_name(raw)
    if derived:
        return derived
    if not _warned_missing_identity:
        logger.warning(
            "swarm plugin: hermes session has no AGENT_IDENTITY / SWARM_HERMES_IDENTITY / "
            "SWARM_IDENTITY env set. Falling back to identity:unknown. Launch via "
            "hermesp (personal) or hermesw (work) to get a real identity token; raw "
            "hermes bypasses the launcher and leaves the swarm boundary undefined."
        )
        _warned_missing_identity = True
    return "unknown"


def _load_config() -> dict[str, Any]:
    """Load Hermes config lazily so tests/imports do not require Hermes internals."""
    try:
        from hermes_cli.config import load_config

        config = load_config()
    except Exception as exc:
        logger.debug("swarm plugin: config load failed, defaulting role to worker: %s", exc)
        return {}
    return config if isinstance(config, dict) else {}


def _configured_role() -> str:
    """Return configured plugin role, defaulting invalid/missing values to worker."""
    config = _load_config()
    swarm = config.get("swarm")
    if not isinstance(swarm, dict) or "role" not in swarm:
        return "worker"

    role = swarm.get("role")
    if role is None or (isinstance(role, str) and not role.strip()):
        return "worker"
    if not isinstance(role, str):
        logger.warning("swarm plugin: invalid swarm.role %r; defaulting to worker", role)
        return "worker"

    normalized = role.strip().lower()
    if normalized not in _VALID_PLUGIN_ROLES:
        logger.warning("swarm plugin: invalid swarm.role %r; defaulting to worker", role)
        return "worker"
    return normalized


def _server_prefix() -> str:
    """MCP server name -- defaults to ``swarm`` (the recommended config key)."""
    return os.environ.get("SWARM_HERMES_MCP_NAME", "swarm")


def _identity_name() -> str:
    return _resolved_identity()


def _work_tracker_config(kwargs: dict[str, Any]) -> dict[str, Any]:
    identity = _identity_name()
    scope = os.environ.get("SWARM_HERMES_SCOPE") or os.environ.get("SWARM_MCP_SCOPE")
    tracker = contract.work_tracker_config(
        "HERMES",
        _session_directory(kwargs),
        scope,
        identity,
    )
    if tracker:
        return tracker

    swarm = _load_config().get("swarm")
    if isinstance(swarm, dict):
        return contract.normalize_work_tracker(
            swarm.get("work_tracker"),
            identity,
            "hermes-config:swarm.work_tracker",
        )
    return {}


def _dispatch(tool_suffix: str, args: dict) -> Optional[dict]:
    """Call ``mcp_<server>_<tool_suffix>`` via the global registry.

    Returns the parsed JSON result, or ``None`` on failure (logged).
    """
    from tools.registry import registry

    tool_name = f"mcp_{_server_prefix()}_{tool_suffix}"
    try:
        raw = registry.dispatch(tool_name, args)
    except Exception as exc:
        logger.warning("swarm plugin: dispatch %s failed: %s", tool_name, exc)
        return None

    if not isinstance(raw, str):
        return raw if isinstance(raw, dict) else None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.debug("swarm plugin: non-JSON response from %s: %r", tool_name, raw[:200])
        return None


def _publish_work_tracker_config(instance_id: str, tracker: dict[str, Any]) -> None:
    if not tracker:
        return
    key = contract.work_tracker_key(str(tracker.get("identity") or ""))
    payload = json.dumps(tracker, separators=(",", ":"))
    result = _extract_payload(_dispatch("kv_set", {"key": key, "value": payload}))
    if isinstance(result, dict) and result.get("error"):
        logger.debug(
            "swarm plugin: failed to publish work tracker config for %s: %s",
            instance_id,
            result.get("error"),
        )


def _decode_json_prefix(text: str) -> Any:
    """Decode the first JSON object from text, ignoring following prompt text."""
    try:
        parsed, _ = _json_decoder.raw_decode(text.lstrip())
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed


def _first_text_block(payload: dict) -> str:
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            return block["text"]
    return ""


def _extract_instance_id(payload: dict) -> str:
    """Extract an instance id from direct or Hermes MCP-wrapped tool output."""
    if not isinstance(payload, dict):
        return ""
    if payload.get("error"):
        logger.info("swarm plugin: register skipped: %s", payload.get("error"))
        return ""

    candidates: list[dict] = [payload]
    nested_instance = payload.get("instance")
    if isinstance(nested_instance, dict):
        candidates.append(nested_instance)

    result = payload.get("result")
    if isinstance(result, dict):
        candidates.append(result)
    elif isinstance(result, str):
        decoded = _decode_json_prefix(result)
        if isinstance(decoded, dict):
            candidates.append(decoded)

    text_block = _first_text_block(payload)
    if text_block:
        decoded = _decode_json_prefix(text_block)
        if isinstance(decoded, dict):
            candidates.append(decoded)

    for candidate in candidates:
        instance_id = candidate.get("instance_id") or candidate.get("id")
        if isinstance(instance_id, str) and instance_id:
            return instance_id

        inner = candidate.get("instance")
        if isinstance(inner, dict):
            instance_id = inner.get("id")
            if isinstance(instance_id, str) and instance_id:
                return instance_id

    return ""


def _session_directory(kwargs: dict[str, Any]) -> str:
    for key in ("directory", "cwd", "workdir", "working_directory"):
        value = kwargs.get(key)
        if value:
            return os.path.abspath(os.path.expanduser(str(value)))

    for key in ("SWARM_MCP_DIRECTORY", "TERMINAL_CWD"):
        value = os.environ.get(key)
        if value:
            return os.path.abspath(os.path.expanduser(value))

    return os.getcwd()


def _register_args(session_id: str, kwargs: dict[str, Any]) -> dict:
    platform = str(kwargs.get("platform") or "").strip()
    plugin_role = _configured_role()
    label = contract.build_label(
        contract.LabelConfig(
            runtime_name="hermes",
            env_prefix="HERMES",
            plugin_role=plugin_role,
            session_id=session_id,
            platform=platform,
            override_label=os.environ.get("SWARM_HERMES_LABEL") or "",
            identity=_resolved_identity(),
            agent_role=(
                os.environ.get("SWARM_HERMES_AGENT_ROLE")
                or os.environ.get("SWARM_AGENT_ROLE")
                or ""
            ),
        )
    )

    args = {
        "directory": _session_directory(kwargs),
        "label": label,
    }
    scope = os.environ.get("SWARM_HERMES_SCOPE") or os.environ.get("SWARM_MCP_SCOPE")
    if scope:
        args["scope"] = scope
    file_root = os.environ.get("SWARM_HERMES_FILE_ROOT") or os.environ.get("SWARM_MCP_FILE_ROOT")
    if file_root:
        args["file_root"] = file_root
    return args


def _extract_payload(payload: dict | None) -> Any:
    """Return the structured payload from direct or Hermes MCP-wrapped output."""
    if not isinstance(payload, dict):
        return None
    if payload.get("error"):
        return payload

    result = payload.get("result")
    if isinstance(result, str):
        decoded = _decode_json_prefix(result)
        if decoded is not None:
            return decoded
    if result is not None:
        return result

    text_block = _first_text_block(payload)
    if text_block:
        decoded = _decode_json_prefix(text_block)
        if decoded is not None:
            return decoded

    return payload


def _lock_key(session_id: str, tool_name: str, tool_call_id: str, paths: list[str]) -> str:
    if tool_call_id:
        return f"tool-call:{tool_call_id}"
    return f"{session_id}:{tool_name}:{'|'.join(paths)}"


def _dedupe_paths(paths: list[str]) -> list[str]:
    return contract.dedupe_paths(paths)


def _abs_path(path: str) -> str:
    return contract.abs_path(path, lambda: _session_directory({}))


def _paths_for_tool(tool_name: str, args: dict[str, Any]) -> list[str]:
    if not isinstance(args, dict):
        return []
    paths: list[str] = []

    if tool_name == "write_file":
        path = args.get("path")
        if isinstance(path, str):
            paths.append(_abs_path(path))
        return _dedupe_paths(paths)

    if tool_name in {"patch", "apply_patch"}:
        path = args.get("path")
        if isinstance(path, str):
            paths.append(_abs_path(path))
        patch_text = args.get("patch") or args.get("patchText")
        if isinstance(patch_text, str):
            paths.extend(contract.apply_patch_paths(patch_text, lambda: _session_directory({})))
        return _dedupe_paths(paths)

    for key in ("path", "file", "file_path", "filepath"):
        path = args.get(key)
        if isinstance(path, str):
            paths.append(_abs_path(path))
    return _dedupe_paths(paths)


def _has_peers(session_id: str) -> bool:
    with _lock:
        instance_id = _instances.get(session_id, "")
    if not instance_id:
        return False

    payload = _extract_payload(_dispatch("list_instances", {}))
    if not isinstance(payload, list):
        logger.debug("swarm plugin: peer check skipped, unexpected list_instances payload: %r", payload)
        return False

    peers = [item for item in payload if isinstance(item, dict) and item.get("id") != instance_id]
    return bool(peers)


def _effective_session_id(session_id: str) -> str:
    """Hermes currently omits session_id on some pre-tool hook paths."""
    if session_id:
        return session_id
    with _lock:
        if len(_instances) == 1:
            return next(iter(_instances))
    return ""


def _lock_file(path: str, tool_name: str) -> tuple[bool, str]:
    payload = _extract_payload(
        _dispatch("lock_file", {"file": path, "reason": f"hermes auto-lock before {tool_name}"})
    )
    if isinstance(payload, dict) and payload.get("error"):
        message = str(payload.get("error") or "lock failed")
        if "locked" in message.lower():
            return False, message
        logger.debug("swarm plugin: lock skipped for %s: %s", path, message)
        return True, ""
    return True, ""


def _unlock_file(path: str) -> None:
    payload = _extract_payload(_dispatch("unlock_file", {"file": path}))
    if isinstance(payload, dict) and payload.get("error"):
        logger.debug("swarm plugin: unlock skipped for %s: %s", path, payload.get("error"))


def on_pre_tool_call(
    tool_name: str = "",
    args: Optional[dict] = None,
    session_id: str = "",
    tool_call_id: str = "",
    **_: Any,
) -> Optional[dict]:
    """Auto-acquire swarm edit locks for write-like file tools when peers exist."""
    session_id = _effective_session_id(session_id)
    if tool_name not in _WRITE_TOOLS or not session_id:
        return None
    if get_role(session_id) == "gateway":
        logger.debug("swarm plugin: gateway mode skips auto-lock for %s", tool_name)
        return None

    paths = _paths_for_tool(tool_name, args or {})
    if not paths or not _has_peers(session_id):
        return None

    acquired: list[str] = []
    for path in paths:
        ok, message = _lock_file(path, tool_name)
        if not ok:
            for locked_path in reversed(acquired):
                _unlock_file(locked_path)
            return {
                "action": "block",
                "message": f"swarm lock blocked {tool_name} for {path}: {message}",
            }
        acquired.append(path)

    if acquired:
        with _lock:
            _locks_by_call[_lock_key(session_id, tool_name, tool_call_id, paths)] = acquired
        logger.debug("swarm plugin: locked %s for %s", ", ".join(acquired), tool_name)
    return None


def on_post_tool_call(
    tool_name: str = "",
    args: Optional[dict] = None,
    session_id: str = "",
    tool_call_id: str = "",
    **_: Any,
) -> None:
    """Release locks acquired by ``on_pre_tool_call`` after success or error."""
    session_id = _effective_session_id(session_id)
    if tool_name not in _WRITE_TOOLS or not session_id:
        return

    paths = _paths_for_tool(tool_name, args or {})
    key = _lock_key(session_id, tool_name, tool_call_id, paths)
    with _lock:
        locked_paths = _locks_by_call.pop(key, [])

    for path in reversed(locked_paths):
        _unlock_file(path)
    if locked_paths:
        logger.debug("swarm plugin: unlocked %s after %s", ", ".join(locked_paths), tool_name)


def on_session_start(session_id: str = "", **kwargs: Any) -> None:
    """Register this session with swarm. Idempotent per session_id."""
    if not session_id:
        logger.debug("swarm plugin: register skipped (empty session_id)")
        return
    with _lock:
        if session_id in _instances:
            logger.debug("swarm plugin: already registered for session %s", session_id)
            return

    role = _configured_role()
    register_args = _register_args(session_id, kwargs)
    logger.debug("swarm plugin: dispatching register with args=%r", register_args)
    result = _dispatch("register", register_args)
    if not result:
        logger.debug("swarm plugin: register skipped (dispatch returned no result)")
        return

    instance_id = _extract_instance_id(result)
    if instance_id:
        with _lock:
            _instances[session_id] = instance_id
            _roles_by_session[session_id] = role
            _refcounts[instance_id] = _refcounts.get(instance_id, 0) + 1
        from . import prompt_peer

        prompt_peer.publish_current_identity(instance_id)
        _publish_work_tracker_config(instance_id, _work_tracker_config(kwargs))
        logger.info("swarm plugin: registered as %s", instance_id)
    else:
        logger.debug(
            "swarm plugin: register returned no extractable instance_id: %r",
            result,
        )


def on_session_finalize(session_id: str = "", **_: Any) -> None:
    """Deregister once the last Hermes session using this MCP instance ends."""
    with _lock:
        instance_id = _instances.pop(session_id, "")
        _roles_by_session.pop(session_id, None)
        if instance_id:
            count = max(0, _refcounts.get(instance_id, 0) - 1)
            if count:
                _refcounts[instance_id] = count
                return
            _refcounts.pop(instance_id, None)
    if not instance_id:
        return

    from . import prompt_peer

    prompt_peer.delete_current_identity(instance_id)
    result = _dispatch("deregister", {})
    if result and result.get("error"):
        logger.debug("swarm plugin: deregister skipped for %s: %s", instance_id, result["error"])
    elif result is None:
        logger.debug("swarm plugin: deregister skipped for %s (server not available?)", instance_id)
    else:
        logger.info("swarm plugin: deregistered %s", instance_id)


def on_session_end(session_id: str = "", **_: Any) -> None:
    """Hermes fires this per turn; keep it non-destructive."""
    return None


def get_instance_id(session_id: str) -> str:
    """Lookup helper -- used by the /swarm slash command for context."""
    with _lock:
        return _instances.get(session_id, "")


def get_role(session_id: str = "") -> str:
    """Lookup the cached plugin role for a session, defaulting to worker."""
    session_id = _effective_session_id(session_id)
    with _lock:
        return _roles_by_session.get(session_id, "worker")
