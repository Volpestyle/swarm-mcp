"""Workspace identity helpers for swarm-aware Hermes sessions.

The adapter-neutral swarm MCP ``prompt_peer`` tool reads this published identity
to best-effort wake Hermes workers that are known to live in a pane.
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


def _herdr_env(identity: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()
    socket_path = identity.get("socket_path")
    if not isinstance(socket_path, str) or not socket_path:
        socket_path = lifecycle.contract.resolved_herdr_socket_path(lifecycle._identity_name())
    if isinstance(socket_path, str) and socket_path:
        env["HERDR_SOCKET_PATH"] = socket_path
    return env
