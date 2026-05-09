"""Runtime-agnostic hook core for swarm subprocess-based plugins.

The Claude Code and Codex CLI plugins both use the same shape of integration:
short-lived subprocess hooks that receive a JSON payload on stdin, optionally
print one back on stdout, and shell out to the ``swarm-mcp`` CLI for
coordination side-effects. This module contains the runtime-agnostic core they
share. Each plugin's ``_common.py`` instantiates ``HookCore`` with a
``RuntimeConfig`` that captures the per-runtime differences:

- Which tool name(s) constitute a "write" event.
- How to extract file paths from a write tool's input (Claude Code uses
  ``tool_input.file_path``; codex parses an ``apply_patch`` envelope).
- The label token, env-var prefix, and scratch directory namespace that
  distinguish one runtime's sessions from another's in the same coordination
  scope.

Hermes does *not* use this module — it integrates with hermes-agent's
in-process plugin API directly, where stdin/stdout subprocess machinery would
be the wrong shape.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional


@dataclass(frozen=True)
class RuntimeConfig:
    """Per-runtime knobs that parameterize HookCore.

    Attributes:
        runtime_name: Token used in derived labels, e.g. ``"claude-code"``.
        env_prefix: Used to build ``SWARM_<prefix>_*`` env-var aliases.
        scratch_dir_name: Top-level dir under ``$TMPDIR`` for per-session
            scratch (e.g. ``"swarm-cc"``).
        write_tools: Set of tool names that should trigger the lock bridge.
        extract_paths: Function ``(tool_name, tool_input) -> [absolute_path]``.
            Receives ``tool_input`` exactly as it appears in the hook payload.
        auto_lock_note: Free-form note attached to ``swarm-mcp lock`` calls so
            operators can see which adapter acquired a given lock.
    """

    runtime_name: str
    env_prefix: str
    scratch_dir_name: str
    write_tools: frozenset[str]
    extract_paths: Callable[[str, object], list[str]]
    auto_lock_note: str


class HookCore:
    """Runtime-agnostic hook implementation.

    Public methods come in two flavors:

    1. **Building blocks** (``swarm_cmd``, ``run_swarm``, ``derived_label``,
       ``has_peers``, …) — for hook scripts that need fine-grained control.
    2. **Top-level hook entry points** (``run_session_start_hook``,
       ``run_pre_tool_use_hook``, ``run_post_tool_use_hook``,
       ``run_session_end_hook``) — drive the full hook lifecycle from a
       stdin file object. Plugin entry scripts can be three-line stubs that
       just call these.
    """

    def __init__(self, config: RuntimeConfig):
        self.config = config

    # -- swarm-mcp CLI resolution -------------------------------------------

    def swarm_cmd(self) -> Optional[list[str]]:
        explicit = os.environ.get("SWARM_MCP_BIN")
        if explicit:
            cmd = self._command_from_explicit(explicit)
            if cmd:
                return cmd

        bin_ = shutil.which("swarm-mcp")
        if bin_:
            return [bin_]

        # Walk up from this file to the swarm-mcp repo root. _shared lives at
        # <repo>/integrations/_shared/, so parents[2] = <repo>.
        repo_root = Path(__file__).resolve().parents[2]
        src_cli = repo_root / "src" / "cli.ts"
        if src_cli.exists() and shutil.which("bun"):
            return ["bun", "run", str(src_cli)]

        dist_cli = repo_root / "dist" / "cli.js"
        if dist_cli.exists() and shutil.which("node"):
            return ["node", str(dist_cli)]

        return None

    @staticmethod
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

    def run_swarm(self, args: list[str], timeout: float = 8.0) -> tuple[int, str, str]:
        cmd = self.swarm_cmd()
        if not cmd:
            return 127, "", "swarm-mcp CLI not found"
        try:
            proc = subprocess.run(
                [*cmd, *args],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=self.session_cwd(),
            )
            return proc.returncode, proc.stdout, proc.stderr
        except subprocess.TimeoutExpired:
            return 124, "", "swarm-mcp CLI timed out"
        except Exception as exc:  # pragma: no cover -- surface in stderr
            return 1, "", f"swarm-mcp CLI failed: {exc}"

    # -- Identity / scope / label -------------------------------------------

    @staticmethod
    def session_cwd() -> str:
        return (
            os.environ.get("SWARM_MCP_DIRECTORY")
            or os.environ.get("TERMINAL_CWD")
            or os.getcwd()
        )

    def _env(self, suffix: str) -> Optional[str]:
        return os.environ.get(f"SWARM_{self.config.env_prefix}_{suffix}")

    def scope_arg(self) -> Optional[str]:
        return (
            self._env("SCOPE")
            or os.environ.get("SWARM_HERMES_SCOPE")
            or os.environ.get("SWARM_MCP_SCOPE")
        )

    def file_root_arg(self) -> Optional[str]:
        return (
            self._env("FILE_ROOT")
            or os.environ.get("SWARM_HERMES_FILE_ROOT")
            or os.environ.get("SWARM_MCP_FILE_ROOT")
        )

    def identity_token(self) -> str:
        value = (
            self._env("IDENTITY")
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

    def agent_role_token(self) -> str:
        """Return ``role:<name>`` if the agent has a swarm-visible skill role.

        Sources, in order:
        1. ``SWARM_<prefix>_AGENT_ROLE`` env var (e.g. ``SWARM_CC_AGENT_ROLE``).
        2. ``.swarm-role`` file walking up from cwd to the coordination scope.
        3. ``SWARM_AGENT_ROLE`` (un-prefixed shared fallback).

        Plugin-mode knobs (``SWARM_<prefix>_ROLE`` carrying ``worker``/``gateway``)
        are intentionally **not** read here — those drive plugin behavior, not
        the swarm-visible label. The hermes / claude-code gateway-role plumbing
        owns that knob; this method owns only the routing label peers see.
        """
        raw = (self._env("AGENT_ROLE") or "").strip()
        if not raw:
            raw = self._role_from_file()
        if not raw:
            raw = (os.environ.get("SWARM_AGENT_ROLE") or "").strip()
        return self._normalize_role(raw)

    @staticmethod
    def _normalize_role(value: str) -> str:
        value = value.strip().lower()
        if not value or value == "worker":
            return ""
        if not re.match(r"^[a-z0-9_.-]+$", value):
            return ""
        return f"role:{value}"

    def _role_doctrine_lines(self, role_token: str) -> list[str]:
        """Resolve ``role:<name>`` to a pointer at the matching skill reference.

        The bundled swarm-mcp skill keeps role doctrine in
        ``skills/swarm-mcp/references/<role>.md``. We hand the agent the
        absolute path so it can read the doctrine on turn 1 regardless of
        whether the skill itself has been auto-loaded yet.

        ``generalist`` (and any role without a dedicated reference) falls
        back to ``roles-and-teams.md`` which surveys all roles.
        """
        if not role_token.startswith("role:"):
            return []
        role_name = role_token.split(":", 1)[1].strip().lower()
        if not role_name:
            return []

        # _shared lives at <repo>/integrations/_shared/, so parents[2] = <repo>.
        repo_root = Path(__file__).resolve().parents[2]
        refs = repo_root / "skills" / "swarm-mcp" / "references"
        target = refs / f"{role_name}.md"
        if not target.is_file():
            target = refs / "roles-and-teams.md"
        if not target.is_file():
            return []

        return [
            "",
            f"You're registered as `{role_token}`. Before your first work decision,",
            f"read `{target}` — it contains the role-specific doctrine (when to",
            "delegate via `request_task` vs. do hands-on, how to claim/update tasks,",
            "what peers to coordinate with). The bundled `swarm-mcp` skill is the",
            "broader source of truth.",
        ]

    def _role_from_file(self) -> str:
        """Walk up from cwd to scope (or filesystem root) looking for ``.swarm-role``.

        First match wins. File contents are a single role token on the first
        non-blank, non-comment line. Use this for repo-wide defaults — drop
        ``echo implementer > .swarm-role`` at the repo root and every adapter
        in that scope picks it up without env-var ceremony.
        """
        try:
            start = Path(self.session_cwd()).resolve()
        except Exception:
            return ""
        scope = self.scope_arg()
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

    @staticmethod
    def session_short(session_id: str) -> str:
        return (session_id or "").replace("-", "")[:8]

    def derived_label(self, session_id: str) -> str:
        override = self._env("LABEL") or os.environ.get("SWARM_HERMES_LABEL")
        if override:
            if any(part.startswith("identity:") for part in override.split()):
                return override
            token = self.identity_token()
            return f"{token} {override}".strip() if token else override

        parts: list[str] = []
        token = self.identity_token()
        if token:
            parts.append(token)
        parts.append(self.config.runtime_name)
        parts.append("platform:cli")
        role = self.agent_role_token()
        if role:
            parts.append(role)
        parts.append(f"origin:{self.config.runtime_name}")
        short = self.session_short(session_id)
        if short:
            parts.append(f"session:{short}")
        return " ".join(parts)

    # -- Per-session scratch dir --------------------------------------------

    def _scratch_root(self) -> Path:
        return Path(tempfile.gettempdir()) / self.config.scratch_dir_name

    def session_scratch(self, session_id: str) -> Path:
        p = self._scratch_root() / (session_id or "default")
        p.mkdir(parents=True, exist_ok=True)
        return p

    def write_session_meta(self, session_id: str, meta: dict) -> None:
        if not session_id:
            return
        (self.session_scratch(session_id) / "meta.json").write_text(json.dumps(meta))

    def read_session_meta(self, session_id: str) -> dict:
        if not session_id:
            return {}
        path = self.session_scratch(session_id) / "meta.json"
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text())
        except Exception:
            return {}

    # -- Hook IO ------------------------------------------------------------

    @staticmethod
    def read_hook_input(stdin) -> dict:
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

    def write_paths_for_tool(self, tool_name: str, tool_input: object) -> list[str]:
        if tool_name not in self.config.write_tools:
            return []
        return self.config.extract_paths(tool_name, tool_input)

    @staticmethod
    def emit_block(reason: str) -> None:
        payload = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }
        print(json.dumps(payload))

    @staticmethod
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

    def has_peers(self, scope: Optional[str], session_id: str) -> bool:
        args = ["instances", "--json"]
        if scope:
            args.extend(["--scope", scope])
        rc, out, _ = self.run_swarm(args, timeout=4.0)
        if rc != 0:
            return False

        peers = self.parse_instances_json(out)
        if not peers:
            return False

        short = self.session_short(session_id)
        own_marker = f"session:{short}" if short else ""

        def looks_like_self(inst: dict) -> bool:
            if not own_marker:
                return False
            label = " ".join(
                str(inst.get(k) or "") for k in ("label", "labels", "role", "name")
            )
            return own_marker in label

        return any(not looks_like_self(inst) for inst in peers)

    def as_selector(self, session_id: str) -> Optional[str]:
        short = self.session_short(session_id)
        if not short:
            return None
        return f"session:{short}"

    # -- Lock tracking across pre/post --------------------------------------

    def iter_locked_paths(self, session_id: str, key: str) -> Iterable[str]:
        path = self.session_scratch(session_id) / f"locks-{key}.json"
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text())
        except Exception:
            return []
        if not isinstance(data, list):
            return []
        return [p for p in data if isinstance(p, str)]

    def record_locks(self, session_id: str, key: str, paths: list[str]) -> None:
        target = self.session_scratch(session_id) / f"locks-{key}.json"
        target.write_text(json.dumps(paths))

    def clear_locks(self, session_id: str, key: str) -> None:
        target = self.session_scratch(session_id) / f"locks-{key}.json"
        if target.exists():
            try:
                target.unlink()
            except Exception:
                pass

    def lock_key(self, tool_name: str, tool_input: object) -> str:
        paths = "|".join(self.write_paths_for_tool(tool_name, tool_input))
        return f"{tool_name}:{paths}"

    # -- High-level hook entry points ---------------------------------------

    def build_session_start_context(self, session_id: str, cwd: str) -> str:
        label = self.derived_label(session_id)
        scope = self.scope_arg()
        file_root = self.file_root_arg()

        register_args: dict[str, str] = {
            "directory": cwd or self.session_cwd(),
            "label": label,
        }
        if scope:
            register_args["scope"] = scope
        if file_root:
            register_args["file_root"] = file_root

        pretty = json.dumps(register_args, indent=2)
        lines = [
            "## swarm coordination is available",
            "",
            "Call the `register` tool from the `swarm` MCP server early in this session.",
            "Use exactly these args so peer locks and `/swarm` can resolve your identity:",
            "",
            "```json",
            pretty,
            "```",
            "",
            "After registering, follow the `swarm-mcp` skill: `whoami`, `list_instances`,",
            "`poll_messages`, `list_tasks`, then act on any pending work.",
        ]

        role_token = self.agent_role_token()
        if role_token:
            doctrine_lines = self._role_doctrine_lines(role_token)
            if doctrine_lines:
                lines.extend(doctrine_lines)
        else:
            env_var = f"SWARM_{self.config.env_prefix}_AGENT_ROLE"
            lines.extend(
                [
                    "",
                    "No `role:` was detected from env or `.swarm-role`. If you're acting as a",
                    "specific skill role (`planner`, `implementer`, `reviewer`, `researcher`,",
                    "`generalist`), append it to the `label` above as `role:<name>` so peers",
                    "can route to you via `list_instances`. To make this automatic, set",
                    f"`{env_var}` or drop a one-line `.swarm-role` file at the repo root.",
                ]
            )

        herdr_pane = os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE")
        if herdr_pane:
            payload: dict[str, str] = {"pane_id": herdr_pane}
            socket_path = os.environ.get("HERDR_SOCKET_PATH")
            if socket_path:
                payload["socket_path"] = socket_path
            workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
            if workspace_id:
                payload["workspace_id"] = workspace_id
            blob = json.dumps(payload, separators=(",", ":"))
            lines.extend(
                [
                    "",
                    "After `register` returns your `instance_id`, also publish your herdr",
                    "pane handle so peers can wake you with `swarm_prompt_peer`-style flows:",
                    "",
                    "```text",
                    f'kv_set key="identity/herdr/<your_instance_id>" value=\'{blob}\'',
                    "```",
                ]
            )

        return "\n".join(lines)

    def run_session_start_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        session_id = str(payload.get("session_id") or "")
        cwd = str(payload.get("cwd") or self.session_cwd())
        source = str(payload.get("source") or "startup")

        label = self.derived_label(session_id)
        self.write_session_meta(
            session_id,
            {
                "label": label,
                "session_short": self.session_short(session_id),
                "scope": self.scope_arg() or "",
                "file_root": self.file_root_arg() or "",
                "cwd": cwd,
                "herdr_pane_id": os.environ.get("HERDR_PANE_ID")
                or os.environ.get("HERDR_PANE")
                or "",
            },
        )

        if source not in {"startup", "resume"} or not session_id:
            return 0

        context = self.build_session_start_context(session_id, cwd)
        out = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            }
        }
        print(json.dumps(out))
        return 0

    def _looks_like_lock_conflict(self, stdout: str, stderr: str) -> bool:
        blob = f"{stdout}\n{stderr}".lower()
        return "locked" in blob or "lock conflict" in blob

    def _lock_one(
        self, path: str, selector: Optional[str], scope: Optional[str]
    ) -> tuple[bool, str]:
        args = ["lock", path, "--note", self.config.auto_lock_note]
        if selector:
            args.extend(["--as", selector])
        if scope:
            args.extend(["--scope", scope])
        rc, out, err = self.run_swarm(args, timeout=6.0)
        if rc == 0:
            return True, ""
        if self._looks_like_lock_conflict(out, err):
            return False, (err.strip() or out.strip() or "File is already locked")
        return True, ""

    def _unlock_paths(
        self, paths: list[str], selector: Optional[str], scope: Optional[str]
    ) -> None:
        for path in reversed(paths):
            args = ["unlock", path]
            if selector:
                args.extend(["--as", selector])
            if scope:
                args.extend(["--scope", scope])
            self.run_swarm(args, timeout=4.0)

    def run_pre_tool_use_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        tool_name = str(payload.get("tool_name") or "")
        if tool_name not in self.config.write_tools:
            return 0

        tool_input = payload.get("tool_input")
        paths = self.write_paths_for_tool(tool_name, tool_input)
        if not paths:
            return 0

        session_id = str(payload.get("session_id") or "")
        meta = self.read_session_meta(session_id)
        scope = meta.get("scope") or self.scope_arg()

        if not self.has_peers(scope, session_id):
            return 0

        selector = self.as_selector(session_id)
        acquired: list[str] = []
        for path in paths:
            ok, message = self._lock_one(path, selector, scope)
            if not ok:
                self._unlock_paths(acquired, selector, scope)
                self.emit_block(
                    f"swarm lock blocked {tool_name} for {path}: {message}"
                )
                return 0
            acquired.append(path)

        if acquired:
            self.record_locks(
                session_id, self.lock_key(tool_name, tool_input), acquired
            )
        return 0

    def run_post_tool_use_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        tool_name = str(payload.get("tool_name") or "")
        if tool_name not in self.config.write_tools:
            return 0

        tool_input = payload.get("tool_input")
        session_id = str(payload.get("session_id") or "")
        if not session_id:
            return 0

        key = self.lock_key(tool_name, tool_input)
        paths = list(self.iter_locked_paths(session_id, key))
        if not paths:
            return 0

        meta = self.read_session_meta(session_id)
        scope = meta.get("scope") or self.scope_arg()
        selector = self.as_selector(session_id)
        self._unlock_paths(paths, selector, scope)
        self.clear_locks(session_id, key)
        return 0

    def _resolve_instance_id(
        self, session_id: str, scope: Optional[str]
    ) -> Optional[str]:
        short = self.session_short(session_id)
        if not short:
            return None
        args = ["instances", "--json"]
        if scope:
            args.extend(["--scope", scope])
        rc, out, _ = self.run_swarm(args, timeout=4.0)
        if rc != 0:
            return None
        marker = f"session:{short}"
        for inst in self.parse_instances_json(out):
            label = " ".join(
                str(inst.get(k) or "") for k in ("label", "labels", "role", "name")
            )
            if marker in label:
                inst_id = inst.get("id") or inst.get("instance_id")
                if isinstance(inst_id, str) and inst_id:
                    return inst_id
        return None

    def run_session_end_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        session_id = str(payload.get("session_id") or "")
        meta = self.read_session_meta(session_id)
        scope = meta.get("scope") or self.scope_arg()

        instance_id = self._resolve_instance_id(session_id, scope)
        if instance_id:
            kv_args = ["kv", "del", f"identity/herdr/{instance_id}", "--as", instance_id]
            if scope:
                kv_args.extend(["--scope", scope])
            self.run_swarm(kv_args, timeout=4.0)

        if session_id:
            try:
                shutil.rmtree(self.session_scratch(session_id), ignore_errors=True)
            except Exception:
                pass
        return 0
