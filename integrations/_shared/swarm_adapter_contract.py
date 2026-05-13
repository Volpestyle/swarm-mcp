"""Shared adapter contract for swarm runtime integrations.

Different hosts expose different hook mechanics: Claude Code and Codex run
short-lived subprocess hooks, while Hermes calls an in-process plugin API. This
module centralizes the behavior that should not drift across those wrappers:
identity labels, role tokens, session markers, and common patch path parsing.
"""

from __future__ import annotations

import os
import re
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Optional


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


def identity_name(value: str) -> str:
    clean = value.strip()
    if clean.startswith("identity:"):
        clean = clean.split(":", 1)[1]
    if not clean or not re.match(r"^[A-Za-z0-9_.-]+$", clean):
        return ""
    return clean


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


WORK_TRACKER_OPTIONAL_KEYS = (
    "team",
    "project",
    "repo",
    "workspace",
    "board",
    "url",
    "default_state",
    "component",
)


def _clean_tracker_value(value: Any, max_len: int = 512) -> str:
    if value is None:
        return ""
    clean = str(value).strip()
    if not clean or "\n" in clean or "\r" in clean:
        return ""
    return clean[:max_len]


def _select_tracker_payload(raw: Any, identity: str) -> dict[str, Any]:
    if isinstance(raw, str):
        clean = raw.strip()
        if not clean:
            return {}
        try:
            raw = json.loads(clean)
        except json.JSONDecodeError:
            if ":" in clean:
                provider, mcp = clean.split(":", 1)
                return {"provider": provider, "mcp": mcp}
            return {}

    if not isinstance(raw, dict):
        return {}

    if "provider" in raw or "mcp" in raw or "mcp_server" in raw:
        return raw

    for container_key in ("work_tracker", "workTrackers", "trackers"):
        nested = raw.get(container_key)
        selected = _select_tracker_payload(nested, identity)
        if selected:
            return selected

    if identity:
        selected = raw.get(identity)
        if isinstance(selected, dict):
            return selected

    default = raw.get("default")
    if isinstance(default, dict):
        return default

    return {}


def normalize_work_tracker(raw: Any, identity: str = "", source: str = "") -> dict[str, Any]:
    identity = identity_name(identity)
    payload = _select_tracker_payload(raw, identity)
    if not identity:
        identity = identity_name(str(payload.get("identity") or ""))
    provider = _clean_tracker_value(payload.get("provider") or payload.get("type"))
    mcp = _clean_tracker_value(
        payload.get("mcp")
        or payload.get("mcp_server")
        or payload.get("server")
        or payload.get("tool")
    )
    if not provider or not mcp:
        return {}

    result: dict[str, Any] = {
        "schema_version": 1,
        "identity": identity or "default",
        "provider": provider,
        "mcp": mcp,
    }
    clean_source = _clean_tracker_value(source)
    if clean_source:
        result["source"] = clean_source
    for key in WORK_TRACKER_OPTIONAL_KEYS:
        value = _clean_tracker_value(payload.get(key))
        if value:
            result[key] = value
    return result


def _env_tracker_payload(env_prefix: str, identity: str) -> dict[str, Any]:
    prefixes = []
    clean_prefix = env_prefix.strip().upper()
    if clean_prefix:
        prefixes.append(f"SWARM_{clean_prefix}_")
    prefixes.append("SWARM_")

    for prefix in prefixes:
        name = f"{prefix}WORK_TRACKER"
        value = os.environ.get(name)
        if value:
            tracker = normalize_work_tracker(value, identity, f"env:{name}")
            if tracker:
                return tracker

    for prefix in prefixes:
        provider = os.environ.get(f"{prefix}WORK_TRACKER_PROVIDER")
        mcp = os.environ.get(f"{prefix}WORK_TRACKER_MCP") or os.environ.get(
            f"{prefix}WORK_TRACKER_MCP_SERVER"
        )
        if not provider and not mcp:
            continue
        payload: dict[str, Any] = {"provider": provider, "mcp": mcp}
        for key in WORK_TRACKER_OPTIONAL_KEYS:
            env_key = f"{prefix}WORK_TRACKER_{key.upper()}"
            if os.environ.get(env_key):
                payload[key] = os.environ[env_key]
        tracker = normalize_work_tracker(payload, identity, f"env:{prefix}WORK_TRACKER_*")
        if tracker:
            return tracker

    return {}


def _work_tracker_file(start_dir: str, scope: Optional[str], identity: str) -> dict[str, Any]:
    try:
        start = Path(start_dir).resolve()
    except Exception:
        return {}
    try:
        stop_at = Path(scope).resolve() if scope else None
    except Exception:
        stop_at = None

    for directory in [start, *start.parents]:
        for filename in (".swarm-work-tracker", ".swarm-work-tracker.json"):
            marker = directory / filename
            if not marker.is_file():
                continue
            try:
                raw = json.loads(marker.read_text())
            except Exception:
                return {}
            return normalize_work_tracker(raw, identity, f"file:{filename}")
        if stop_at is not None and directory == stop_at:
            break
    return {}


def work_tracker_config(
    env_prefix: str,
    start_dir: str,
    scope: Optional[str] = None,
    identity: str = "",
) -> dict[str, Any]:
    """Resolve configured work tracker metadata for a runtime session.

    This intentionally carries only routing metadata, never credentials. Runtime
    launchers/config roots still own actual MCP auth.
    """

    clean_identity = identity_name(identity)
    return _env_tracker_payload(env_prefix, clean_identity) or _work_tracker_file(
        start_dir,
        scope,
        clean_identity,
    )


def work_tracker_key(identity: str) -> str:
    clean = identity_name(identity) or "default"
    return f"config/work_tracker/{clean}"


def _host_home() -> str:
    return (
        os.environ.get("HERMES_HOST_HOME")
        or os.environ.get("SWARM_HOST_HOME")
        or str(Path.home())
    )


def _expand_home(path: str) -> str:
    clean = str(path or "").strip()
    if clean == "~":
        return os.path.abspath(_host_home())
    if clean.startswith("~/"):
        return os.path.abspath(os.path.join(_host_home(), clean[2:]))
    return os.path.abspath(os.path.expanduser(clean))


def _profile_config_dir() -> str:
    explicit = os.environ.get("SWARM_MCP_PROFILE_DIR", "").strip()
    if explicit:
        return _expand_home(explicit)
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = _expand_home(xdg) if xdg else os.path.join(_host_home(), ".config")
    return os.path.join(base, "swarm-mcp")


_VALID_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_QUOTED = re.compile(r"""^(['"])(.*)\1$""")


def _parse_env_file(content: str) -> dict[str, str]:
    out: dict[str, str] = {}

    def expand_value(value: str) -> str:
        def braced_default(match: re.Match[str]) -> str:
            key, fallback = match.group(1), match.group(2)
            return os.environ.get(key, out.get(key, "")).strip() or fallback

        def braced(match: re.Match[str]) -> str:
            key = match.group(1)
            return os.environ.get(key, out.get(key, "")).strip()

        def bare(match: re.Match[str]) -> str:
            key = match.group(1)
            return os.environ.get(key, out.get(key, "")).strip()

        value = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}", braced_default, value)
        value = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", braced, value)
        return re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", bare, value)

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        if not _VALID_KEY.match(key):
            continue
        value = value.strip()
        match = _QUOTED.match(value)
        if match:
            value = match.group(2)
        value = expand_value(value)
        out[key] = value
    return out


def load_profile_env(profile: str) -> dict[str, str]:
    """Load ``<profile>.env`` from the swarm-mcp profile config dir.

    Returns an empty dict when the profile name is empty or the file is
    missing/unreadable. Mirrors src/profile_env.ts on the TS side.
    """
    profile = (profile or "").strip()
    if not profile:
        return {}
    path = os.path.join(_profile_config_dir(), f"{profile}.env")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return _parse_env_file(handle.read())
    except OSError:
        return {}


def resolved_herdr_socket_path(identity: str = "") -> str:
    """Return the herdr control socket path for ``identity``.

    Order: explicit ``HERDR_SOCKET_PATH`` env wins, then the matching
    profile env file's ``HERDR_SOCKET_PATH`` entry. Returns ``""`` when
    neither is set.
    """
    explicit = os.environ.get("HERDR_SOCKET_PATH", "").strip()
    if explicit:
        return explicit
    clean_identity = identity_name(identity)
    if not clean_identity:
        return ""
    return load_profile_env(clean_identity).get("HERDR_SOCKET_PATH", "").strip()
