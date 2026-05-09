"""Shared helpers for the swarm Claude Code plugin hooks.

Resolves the ``swarm-mcp`` CLI without relying on shell aliases (Claude Code
hooks run as direct subprocesses), derives identity/scope/file-root args, and
manages a small per-session scratch dir so PreToolUse and PostToolUse can share
state without touching the database.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable, Optional


# Tools whose payloads carry a file path the agent is about to write.
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def swarm_cmd() -> Optional[list[str]]:
    """Return an argv-style command that runs the swarm-mcp CLI, or None.

    Resolution order matches the hermes plugin so operators can share env:
    1. ``SWARM_MCP_BIN`` as a real command (e.g. ``bun run /path/to/cli.ts``)
    2. ``swarm-mcp`` on ``$PATH``
    3. The repo checkout's ``src/cli.ts`` under ``bun`` or ``dist/cli.js`` under ``node``
    """
    explicit = os.environ.get("SWARM_MCP_BIN")
    if explicit:
        cmd = _command_from_explicit(explicit)
        if cmd:
            return cmd

    bin_ = shutil.which("swarm-mcp")
    if bin_:
        return [bin_]

    repo_root = Path(__file__).resolve().parents[3]
    src_cli = repo_root / "src" / "cli.ts"
    if src_cli.exists() and shutil.which("bun"):
        return ["bun", "run", str(src_cli)]

    dist_cli = repo_root / "dist" / "cli.js"
    if dist_cli.exists() and shutil.which("node"):
        return ["node", str(dist_cli)]

    return None


def _command_from_explicit(value: str) -> Optional[list[str]]:
    parts = shlex.split(value)
    if not parts:
        return None
    if shutil.which(parts[0]):
        return parts
    target = Path(parts[0]).expanduser()
    if target.exists() and target.suffix == ".ts" and shutil.which("bun"):
        return ["bun", "run", str(target), *parts[1:]]
    if target.exists() and target.suffix == ".js" and shutil.which("node"):
        return ["node", str(target), *parts[1:]]
    return None


def run_swarm(args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
    cmd = swarm_cmd()
    if not cmd:
        return 127, "", "swarm-mcp CLI not found"
    try:
        proc = subprocess.run(
            [*cmd, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=session_cwd(),
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "swarm-mcp CLI timed out"
    except Exception as exc:  # pragma: no cover -- surface in stderr
        return 1, "", f"swarm-mcp CLI failed: {exc}"


def session_cwd() -> str:
    return (
        os.environ.get("SWARM_MCP_DIRECTORY")
        or os.environ.get("TERMINAL_CWD")
        or os.getcwd()
    )


def scope_arg() -> Optional[str]:
    return (
        os.environ.get("SWARM_CC_SCOPE")
        or os.environ.get("SWARM_HERMES_SCOPE")
        or os.environ.get("SWARM_MCP_SCOPE")
    )


def file_root_arg() -> Optional[str]:
    return (
        os.environ.get("SWARM_CC_FILE_ROOT")
        or os.environ.get("SWARM_HERMES_FILE_ROOT")
        or os.environ.get("SWARM_MCP_FILE_ROOT")
    )


def with_scope(args: list[str]) -> list[str]:
    scope = scope_arg()
    if scope and "--scope" not in args:
        return [*args, "--scope", scope]
    return args


def identity_token() -> str:
    """Return ``identity:<value>`` if the launcher set one, else ``""``."""
    value = (
        os.environ.get("SWARM_CC_IDENTITY")
        or os.environ.get("SWARM_HERMES_IDENTITY")
        or os.environ.get("AGENT_IDENTITY")
        or os.environ.get("SWARM_IDENTITY")
        or ""
    ).strip()
    if not value:
        return ""
    if not re.match(r"^[A-Za-z0-9_.-]+$", value):
        return ""
    return f"identity:{value}"


def session_short(session_id: str) -> str:
    """Stable short form used inside the swarm label and as ``--as`` selector."""
    return (session_id or "").replace("-", "")[:8]


def derived_label(session_id: str) -> str:
    """Build the label the agent should pass to ``register``.

    Override via ``SWARM_CC_LABEL``. If the override does not already include an
    ``identity:`` token, the launcher-derived one is prepended -- mirrors hermes.
    """
    override = os.environ.get("SWARM_CC_LABEL") or os.environ.get("SWARM_HERMES_LABEL")
    if override:
        if any(part.startswith("identity:") for part in override.split()):
            return override
        token = identity_token()
        return f"{token} {override}".strip() if token else override

    parts: list[str] = []
    token = identity_token()
    if token:
        parts.append(token)
    parts.append("claude-code")
    parts.append("platform:cli")
    short = session_short(session_id)
    if short:
        parts.append(f"session:{short}")
    return " ".join(parts)


# -- Session scratch dir -----------------------------------------------------


def _scratch_root() -> Path:
    return Path(tempfile.gettempdir()) / "swarm-cc"


def session_scratch(session_id: str) -> Path:
    p = _scratch_root() / (session_id or "default")
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_session_meta(session_id: str, meta: dict) -> None:
    if not session_id:
        return
    (session_scratch(session_id) / "meta.json").write_text(json.dumps(meta))


def read_session_meta(session_id: str) -> dict:
    if not session_id:
        return {}
    path = session_scratch(session_id) / "meta.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


# -- Hook IO -----------------------------------------------------------------


def read_hook_input(stdin) -> dict:
    """Parse JSON from stdin, returning ``{}`` if missing/malformed."""
    try:
        raw = stdin.read()
    except Exception:
        return {}
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def write_paths_for_tool(tool_name: str, tool_input: dict) -> list[str]:
    """Return the file paths a write-class tool will touch, in order."""
    if not isinstance(tool_input, dict):
        return []

    seen: set[str] = set()
    out: list[str] = []

    def push(value: object) -> None:
        if isinstance(value, str) and value and value not in seen:
            seen.add(value)
            out.append(value)

    if tool_name in {"Write", "Edit", "MultiEdit"}:
        push(tool_input.get("file_path"))
    elif tool_name == "NotebookEdit":
        push(tool_input.get("notebook_path"))

    # Defensive: some tool variants nest paths or expose alt keys.
    for key in ("path", "file", "filepath"):
        push(tool_input.get(key))

    return [_abs_path(p) for p in out]


def _abs_path(p: str) -> str:
    if os.path.isabs(p):
        return p
    return os.path.abspath(os.path.join(session_cwd(), p))


def emit_block(reason: str) -> None:
    """Print a PreToolUse deny payload for Claude Code."""
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(payload))


def parse_instances_json(stdout: str) -> list[dict]:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return []
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        for key in ("instances", "result", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def has_peers(scope: Optional[str], session_id: str) -> bool:
    """True iff the swarm reports another instance in the same scope."""
    args = ["instances", "--json"]
    if scope:
        args.extend(["--scope", scope])
    rc, out, _ = run_swarm(args, timeout=4.0)
    if rc != 0:
        return False

    peers = parse_instances_json(out)
    if not peers:
        return False

    short = session_short(session_id)
    own_marker = f"session:{short}" if short else ""

    def looks_like_self(inst: dict) -> bool:
        if not own_marker:
            return False
        label = " ".join(
            str(inst.get(k) or "") for k in ("label", "labels", "role", "name")
        )
        return own_marker in label

    others = [inst for inst in peers if not looks_like_self(inst)]
    return bool(others)


def as_selector(session_id: str) -> Optional[str]:
    """`--as` value: the session-short label substring the agent registered with."""
    short = session_short(session_id)
    if not short:
        return None
    return f"session:{short}"


def iter_locked_paths(session_id: str, key: str) -> Iterable[str]:
    path = session_scratch(session_id) / f"locks-{key}.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [p for p in data if isinstance(p, str)]


def record_locks(session_id: str, key: str, paths: list[str]) -> None:
    target = session_scratch(session_id) / f"locks-{key}.json"
    target.write_text(json.dumps(paths))


def clear_locks(session_id: str, key: str) -> None:
    target = session_scratch(session_id) / f"locks-{key}.json"
    if target.exists():
        try:
            target.unlink()
        except Exception:
            pass


def lock_key(tool_name: str, tool_input: dict) -> str:
    """Stable key tying a PreToolUse to its PostToolUse without tool_call_id."""
    paths = "|".join(write_paths_for_tool(tool_name, tool_input))
    return f"{tool_name}:{paths}"
