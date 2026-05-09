"""``/swarm`` slash command -- read-only peek at swarm state.

Shells to the ``swarm-mcp`` CLI rather than dispatching MCP tools so it
works even when no swarm tools are mounted in the current session.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Optional

try:
    from . import lifecycle
except ImportError:  # pragma: no cover - supports direct unit-test imports
    import lifecycle  # type: ignore

logger = logging.getLogger(__name__)


_HELP = """\
Usage: /swarm [status|instances|tasks|kv|messages]

  status      Compact summary (default).
  instances   List active peers in this scope.
  tasks       List tasks (open + recent).
  kv          List shared kv keys.
  messages    Peek at recent messages (does not mark read).

Scope is the git root of the current working directory.
"""


def _swarm_bin() -> Optional[str]:
    """Resolve the swarm-mcp executable name when installed on PATH."""
    if shutil.which("swarm-mcp"):
        return "swarm-mcp"
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


def _swarm_cmd() -> Optional[list[str]]:
    """Resolve the swarm-mcp CLI without relying on shell aliases."""
    explicit = os.environ.get("SWARM_MCP_BIN")
    if explicit:
        cmd = _command_from_explicit(explicit)
        if cmd:
            return cmd

    bin_ = _swarm_bin()
    if bin_:
        return [bin_]

    repo_root = Path(__file__).resolve().parents[2]
    src_cli = repo_root / "src" / "cli.ts"
    if src_cli.exists() and shutil.which("bun"):
        return ["bun", "run", str(src_cli)]

    dist_cli = repo_root / "dist" / "cli.js"
    if dist_cli.exists() and shutil.which("node"):
        return ["node", str(dist_cli)]

    return None


def _command_cwd() -> str:
    return (
        os.environ.get("SWARM_MCP_DIRECTORY")
        or os.environ.get("TERMINAL_CWD")
        or os.getcwd()
    )


def _with_scope(args: list[str]) -> list[str]:
    scope = os.environ.get("SWARM_HERMES_SCOPE") or os.environ.get("SWARM_MCP_SCOPE")
    if scope and "--scope" not in args:
        return [*args, "--scope", scope]
    return args


def _run(args: list[str]) -> tuple[int, str, str]:
    cmd = _swarm_cmd()
    if not cmd:
        return (
            127,
            "",
            "swarm-mcp CLI not found. Install/build swarm-mcp, or set "
            "SWARM_MCP_BIN to a real command, e.g.\n"
            "  SWARM_MCP_BIN='bun run /path/to/swarm-mcp/src/cli.ts'",
        )
    try:
        proc = subprocess.run(
            [*cmd, *_with_scope(args)],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=_command_cwd(),
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "swarm-mcp CLI timed out after 10s"
    except Exception as exc:
        return 1, "", f"swarm-mcp CLI failed: {exc}"


def _format_status(payload: dict, role: str = "worker") -> str:
    lines = ["swarm status:"]
    instances = payload.get("instances") or []
    tasks = payload.get("tasks") or []
    kv = payload.get("kv") or []
    messages = payload.get("messages") or []

    lines.append(f"  role      : {role}")
    lines.append(f"  instances : {len(instances)} active")
    for inst in instances[:5]:
        label = inst.get("label") or inst.get("role") or ""
        lines.append(f"    - {inst.get('id', '?')[:8]}  {label}")
    if len(instances) > 5:
        lines.append(f"    ... +{len(instances) - 5} more")

    open_tasks = [t for t in tasks if t.get("status") not in {"done", "cancelled", "failed"}]
    lines.append(f"  tasks     : {len(open_tasks)} open / {len(tasks)} total")
    lines.append(f"  kv keys   : {len(kv)}")
    lines.append(f"  messages  : {len(messages)} recent")
    return "\n".join(lines)


def handle_slash(raw_args: str) -> str:
    sub = (raw_args or "").strip().split(maxsplit=1)
    cmd = sub[0] if sub else "status"

    if cmd in {"help", "-h", "--help", "?"}:
        return _HELP

    if cmd == "status":
        rc, out, err = _run(["inspect", "--json"])
        if rc != 0:
            return f"swarm-mcp inspect failed:\n{err.strip() or out.strip()}"
        try:
            return _format_status(json.loads(out), role=lifecycle.get_role())
        except json.JSONDecodeError:
            return f"swarm-mcp inspect returned non-JSON:\n{out[:500]}"

    if cmd in {"instances", "tasks", "messages"}:
        rc, out, err = _run([cmd])
        if rc != 0:
            return f"swarm-mcp {cmd} failed:\n{err.strip() or out.strip()}"
        return out.strip() or f"(no {cmd})"

    if cmd == "kv":
        rc, out, err = _run(["kv", "list"])
        if rc != 0:
            return f"swarm-mcp kv list failed:\n{err.strip() or out.strip()}"
        return out.strip() or "(no kv keys)"

    return f"Unknown subcommand: {cmd}\n\n{_HELP}"
