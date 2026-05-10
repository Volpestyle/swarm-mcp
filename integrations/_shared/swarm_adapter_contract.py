"""Shared adapter contract for swarm runtime integrations.

Different hosts expose different hook mechanics: Claude Code and Codex run
short-lived subprocess hooks, while Hermes calls an in-process plugin API. This
module centralizes the behavior that should not drift across those wrappers:
identity labels, role tokens, session markers, and common patch path parsing.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional


PATCH_FILE_RE = re.compile(r"^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$", re.MULTILINE)
PATCH_MOVE_RE = re.compile(r"^\*\*\*\s+Move\s+File:\s*(.+?)\s*->\s*(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class LabelConfig:
    runtime_name: str
    env_prefix: str
    plugin_role: str
    session_id: str
    platform: str = ""
    override_label: str = ""
    identity: str = ""
    agent_role: str = ""


def truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def session_short(session_id: str) -> str:
    return (session_id or "").replace("-", "")[:8]


def identity_token(value: str) -> str:
    clean = value.strip()
    if not clean or not re.match(r"^[A-Za-z0-9_.-]+$", clean):
        return ""
    return f"identity:{clean}"


def role_token(value: str) -> str:
    clean = value.strip().lower()
    if not clean or clean == "worker":
        return ""
    if not re.match(r"^[a-z0-9_.-]+$", clean):
        return ""
    return f"role:{clean}"


def plugin_role(value: str) -> str:
    clean = value.strip().lower()
    return clean if clean in {"worker", "gateway"} else "worker"


def default_agent_role(mode: str, explicit: str = "") -> str:
    clean = explicit.strip()
    if clean:
        return clean
    return "planner" if plugin_role(mode) == "gateway" else ""


def with_session_token(label: str, session_id: str) -> str:
    short = session_short(session_id)
    token = f"session:{short}" if short else ""
    if token and token not in label.split():
        return f"{label} {token}".strip()
    return label


def build_label(config: LabelConfig) -> str:
    identity = identity_token(config.identity)
    if config.override_label:
        label = config.override_label.strip()
        if identity and not any(part.startswith("identity:") for part in label.split()):
            label = f"{identity} {label}"
        return with_session_token(label, config.session_id)

    parts: list[str] = []
    if identity:
        parts.append(identity)
    parts.append(config.runtime_name)
    if config.platform:
        parts.append(f"platform:{config.platform}")
    else:
        parts.append("platform:cli")
    if plugin_role(config.plugin_role) == "gateway":
        parts.append("mode:gateway")
    role = role_token(default_agent_role(config.plugin_role, config.agent_role))
    if role:
        parts.append(role)
    parts.append(f"origin:{config.runtime_name}")
    short = session_short(config.session_id)
    if short:
        parts.append(f"session:{short}")
    return " ".join(parts)


def env_first(names: Iterable[str]) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return ""


def abs_path(path: str, cwd: Callable[[], str]) -> str:
    if not path:
        return ""
    if os.path.isabs(path):
        return path
    return os.path.abspath(os.path.join(cwd(), path))


def dedupe_paths(paths: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for path in paths:
        clean = str(path or "").strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        result.append(clean)
    return result


def apply_patch_paths(patch: str, cwd: Callable[[], str]) -> list[str]:
    paths: list[str] = []
    paths.extend(abs_path(match.group(1).strip(), cwd) for match in PATCH_FILE_RE.finditer(patch))
    for match in PATCH_MOVE_RE.finditer(patch):
        paths.append(abs_path(match.group(1).strip(), cwd))
        paths.append(abs_path(match.group(2).strip(), cwd))
    return dedupe_paths(paths)


def role_from_file(start_dir: str, scope: Optional[str] = None) -> str:
    try:
        start = Path(start_dir).resolve()
    except Exception:
        return ""
    try:
        stop_at = Path(scope).resolve() if scope else None
    except Exception:
        stop_at = None

    for directory in [start, *start.parents]:
        marker = directory / ".swarm-role"
        if marker.is_file():
            try:
                for line in marker.read_text().splitlines():
                    line = line.strip()
                    if line and not line.startswith("#"):
                        return line
            except Exception:
                pass
            return ""
        if stop_at is not None and directory == stop_at:
            break
    return ""
