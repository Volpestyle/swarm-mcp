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
import shlex
import shutil
import subprocess
import tempfile
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

try:
    import swarm_adapter_contract as contract
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from . import swarm_adapter_contract as contract


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

    @staticmethod
    def _truthy(value: Optional[str]) -> bool:
        return contract.truthy(value)

    def plugin_role(self) -> str:
        """Return the adapter behavior role, not the swarm-visible skill role."""
        raw = (self._env("ROLE") or os.environ.get("SWARM_ROLE") or "worker").strip().lower()
        return raw if raw in {"worker", "gateway"} else "worker"

    def lease_seconds(self) -> int:
        raw = self._env("LEASE_SECONDS") or os.environ.get("SWARM_LEASE_SECONDS")
        if not raw:
            return 86400
        try:
            value = int(raw)
        except ValueError:
            return 86400
        return max(0, value)

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
        return contract.identity_token(value)

    def identity_name(self) -> str:
        return contract.identity_name(self.identity_token())

    def work_tracker_config(self, cwd: str = "", scope: Optional[str] = None) -> dict:
        return contract.work_tracker_config(
            self.config.env_prefix,
            cwd or self.session_cwd(),
            scope if scope is not None else self.scope_arg(),
            self.identity_name(),
        )

    def agent_role_token(self) -> str:
        """Return ``role:<name>`` if the agent has a swarm-visible skill role.

        Sources, in order:
        1. ``SWARM_<prefix>_AGENT_ROLE`` env var (e.g. ``SWARM_CC_AGENT_ROLE``).
        2. ``.swarm-role`` file walking up from cwd to the coordination scope.
        3. ``SWARM_AGENT_ROLE`` (un-prefixed shared fallback).
        4. ``role:planner`` when the plugin behavior role is ``gateway``.

        Plugin-mode knobs (``SWARM_<prefix>_ROLE`` carrying ``worker``/``gateway``)
        otherwise drive behavior, not routing. Gateway mode is the exception:
        a gateway is planner-shaped unless the operator explicitly set a more
        specific agent role.
        """
        raw = (self._env("AGENT_ROLE") or "").strip()
        if not raw:
            raw = self._role_from_file()
        if not raw:
            raw = (os.environ.get("SWARM_AGENT_ROLE") or "").strip()
        if not raw and self.plugin_role() == "gateway":
            raw = "planner"
        return contract.role_token(raw)

    @staticmethod
    def _normalize_role(value: str) -> str:
        return contract.role_token(value)

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
        return contract.role_from_file(self.session_cwd(), self.scope_arg())

    @staticmethod
    def session_short(session_id: str) -> str:
        return contract.session_short(session_id)

    def derived_label(self, session_id: str) -> str:
        return contract.build_label(
            contract.LabelConfig(
                runtime_name=self.config.runtime_name,
                env_prefix=self.config.env_prefix,
                plugin_role=self.plugin_role(),
                session_id=session_id,
                override_label=self._env("LABEL") or os.environ.get("SWARM_HERMES_LABEL") or "",
                identity=(self._env("IDENTITY") or os.environ.get("SWARM_HERMES_IDENTITY") or os.environ.get("AGENT_IDENTITY") or os.environ.get("SWARM_IDENTITY") or ""),
                agent_role=(self._env("AGENT_ROLE") or self._role_from_file() or os.environ.get("SWARM_AGENT_ROLE") or ""),
            )
        )

    def _with_session_token(self, label: str, session_id: str) -> str:
        return contract.with_session_token(label, session_id)

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
        path = self.session_scratch(session_id) / f"locks-{self.lock_store_key(key)}.json"
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
        target = self.session_scratch(session_id) / f"locks-{self.lock_store_key(key)}.json"
        target.write_text(json.dumps(paths))

    def clear_locks(self, session_id: str, key: str) -> None:
        target = self.session_scratch(session_id) / f"locks-{self.lock_store_key(key)}.json"
        if target.exists():
            try:
                target.unlink()
            except Exception:
                pass

    def lock_key(self, tool_name: str, tool_input: object) -> str:
        paths = "|".join(self.write_paths_for_tool(tool_name, tool_input))
        return f"{tool_name}:{paths}"

    def lock_store_key(self, key: str) -> str:
        return hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]

    # -- High-level hook entry points ---------------------------------------

    def _register_args(self, session_id: str, cwd: str) -> tuple[list[str], dict[str, str]]:
        label = self.derived_label(session_id)
        directory = cwd or self.session_cwd()
        scope = self.scope_arg()
        file_root = self.file_root_arg()

        cli_args = ["register", directory, "--label", label, "--json"]
        pretty_args: dict[str, str] = {
            "directory": directory,
            "label": label,
        }
        if scope:
            cli_args.extend(["--scope", scope])
            pretty_args["scope"] = scope
        if file_root:
            cli_args.extend(["--file-root", file_root])
            pretty_args["file_root"] = file_root

        lease = self.lease_seconds()
        if lease > 0:
            cli_args.extend(["--lease-seconds", str(lease)])
            pretty_args["lease_seconds"] = str(lease)
        return cli_args, pretty_args

    @staticmethod
    def _parse_json_object(text: str) -> dict:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _herdr_identity(self) -> dict[str, object]:
        herdr_pane = os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE")
        if not herdr_pane:
            return {}
        payload: dict[str, object] = {
            "schema_version": 1,
            "backend": "herdr",
            "handle_kind": "pane",
            "handle": herdr_pane,
            "pane_id": herdr_pane,
        }
        socket_path = os.environ.get("HERDR_SOCKET_PATH")
        if socket_path:
            payload["socket_path"] = socket_path
        workspace_id = os.environ.get("HERDR_WORKSPACE_ID")
        if workspace_id:
            payload["workspace_id"] = workspace_id
        return self._canonicalize_herdr_identity(payload, herdr_pane)

    def _canonicalize_herdr_identity(
        self, identity: dict[str, object], requested_pane_id: str
    ) -> dict[str, object]:
        herdr_bin = os.environ.get("SWARM_HERDR_BIN") or shutil.which("herdr")
        if not herdr_bin:
            return identity

        env = os.environ.copy()
        socket_path = identity.get("socket_path")
        if isinstance(socket_path, str) and socket_path:
            env["HERDR_SOCKET_PATH"] = socket_path
        try:
            proc = subprocess.run(
                [herdr_bin, "pane", "get", requested_pane_id],
                capture_output=True,
                text=True,
                timeout=5,
                env=env,
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
        prior_handle = next_identity.get("handle")
        prior_pane = next_identity.get("pane_id")
        raw_handle_aliases = next_identity.get("handle_aliases")
        raw_pane_aliases = next_identity.get("pane_aliases")
        existing_aliases = []
        if isinstance(raw_handle_aliases, list):
            existing_aliases.extend(raw_handle_aliases)
        if isinstance(raw_pane_aliases, list):
            existing_aliases.extend(raw_pane_aliases)
        aliases = [
            item
            for item in [
                *existing_aliases,
                prior_handle if prior_handle != canonical else None,
                prior_pane if prior_pane != canonical else None,
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

    def _publish_herdr_identity(self, instance_id: str, scope: str) -> bool:
        identity = self._herdr_identity()
        if not identity:
            return False
        blob = json.dumps(identity, separators=(",", ":"))
        ok = True
        for key in [f"identity/workspace/herdr/{instance_id}", f"identity/herdr/{instance_id}"]:
            args = ["kv", "set", key, blob, "--as", instance_id]
            if scope:
                args.extend(["--scope", scope])
            rc, _, _ = self.run_swarm(args, timeout=4.0)
            ok = ok and rc == 0
        return ok

    def _publish_work_tracker_config(
        self,
        instance_id: str,
        scope: str,
        tracker: dict,
    ) -> bool:
        if not tracker:
            return False
        key = contract.work_tracker_key(str(tracker.get("identity") or self.identity_name()))
        blob = json.dumps(tracker, separators=(",", ":"))
        args = ["kv", "set", key, blob, "--as", instance_id]
        if scope:
            args.extend(["--scope", scope])
        rc, _, _ = self.run_swarm(args, timeout=4.0)
        return rc == 0

    def _delete_herdr_identity(self, instance_id: str, scope: str) -> None:
        for key in [f"identity/workspace/herdr/{instance_id}", f"identity/herdr/{instance_id}"]:
            args = ["kv", "del", key, "--as", instance_id]
            if scope:
                args.extend(["--scope", scope])
            self.run_swarm(args, timeout=4.0)

    def _deregister_instance(self, instance_id: str, scope: str) -> None:
        args = ["deregister", "--as", instance_id, "--json"]
        if scope:
            args.extend(["--scope", scope])
        self.run_swarm(args, timeout=4.0)

    def build_session_start_context(
        self,
        session_id: str,
        cwd: str,
        meta: dict,
        registration_error: str = "",
    ) -> str:
        instance_id = str(meta.get("instance_id") or "")
        plugin_role = str(meta.get("plugin_role") or self.plugin_role())
        label = str(meta.get("label") or self.derived_label(session_id))
        scope = str(meta.get("scope") or self.scope_arg() or "")
        role_token = self.agent_role_token()
        tracker = meta.get("work_tracker") if isinstance(meta.get("work_tracker"), dict) else {}

        if instance_id:
            lines = [
                "## swarm coordination is active",
                "",
                f"Instance `{instance_id}` · scope `{scope}` · mode `{plugin_role}`",
                f"Label: `{label}`",
                "",
                "Call the swarm `bootstrap` tool to rehydrate state, then act on any pending work.",
                "See the `swarm-mcp` skill for the coordination protocol.",
                "If bootstrap says you are not registered, retry bootstrap with "
                f"`adopt_instance_id=\"{instance_id}\"` or call register with the "
                "same `adopt_instance_id`; this is the SessionStart lease id "
                "that already owns any published workspace identity.",
            ]
            if meta.get("herdr_identity_published"):
                lines.append(
                    f"Workspace identity published at `identity/workspace/herdr/{instance_id}` for peer wakeups."
                )
            if tracker:
                key = contract.work_tracker_key(str(tracker.get("identity") or ""))
                verb = "published" if meta.get("work_tracker_published") else "detected"
                lines.append(
                    f"Configured work tracker {verb} at `{key}`: "
                    f"provider `{tracker.get('provider')}`, MCP `{tracker.get('mcp')}`. "
                    "Use only that same-identity tracker for durable tracker updates."
                )
        else:
            _, register_args = self._register_args(session_id, cwd)
            pretty_args = json.dumps(register_args, indent=2)
            lines = [
                "## swarm coordination is available",
                "",
                f"SessionStart hook could not auto-register this session (mode: `{plugin_role}`).",
            ]
            if registration_error:
                lines.append(f"Hook error: `{registration_error[:240]}`")
            lines.extend(
                [
                    "",
                    "Call the `register` tool with these exact args, then call `bootstrap`",
                    "and follow the `swarm-mcp` skill:",
                    "",
                    "```json",
                    pretty_args,
                    "```",
                ]
            )
            if tracker:
                key = contract.work_tracker_key(str(tracker.get("identity") or ""))
                blob = json.dumps(tracker, separators=(",", ":"))
                lines.extend(
                    [
                        "",
                        f"After `register` succeeds, publish the configured work tracker at `{key}`:",
                        f'`kv_set key="{key}" value=\'{blob}\'`',
                    ]
                )

        if plugin_role == "gateway":
            lines.append("")
            lines.append(
                "Gateway/lead mode: make trivial, low-risk edits locally when that is fastest; "
                "route medium or large implementation work through the swarm `dispatch` tool. "
                "For non-trivial human-trackable work, read `bootstrap.work_tracker`; if configured "
                "and the matching MCP is available, create/link the tracker item before `dispatch`, "
                "include the tracker URL/ID in the swarm task, and update the tracker with the final "
                "durable outcome if the worker did not. "
                "Do not fall back to native subagents. See the `swarm-mcp` skill (planner "
                "reference) for the full conductor protocol."
            )

        if role_token:
            doctrine_lines = self._role_doctrine_lines(role_token)
            if doctrine_lines:
                lines.extend(doctrine_lines)
        else:
            env_var = f"SWARM_{self.config.env_prefix}_AGENT_ROLE"
            lines.append("")
            lines.append(
                f"No `role:` detected. Set `{env_var}` or drop a `.swarm-role` "
                "file in the repo to add a routing role to this session's label."
            )

        identity = self._herdr_identity()
        if identity and not instance_id:
            blob = json.dumps(identity, separators=(",", ":"))
            lines.extend(
                [
                    "",
                    "After `register` returns an instance id, also publish your workspace handle:",
                    f'`kv_set key="identity/workspace/herdr/<id>" value=\'{blob}\'`',
                ]
            )

        return "\n".join(lines)

    def run_session_start_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        session_id = str(payload.get("session_id") or "")
        cwd = str(payload.get("cwd") or self.session_cwd())
        source = str(payload.get("source") or "startup")

        label = self.derived_label(session_id)
        scope = self.scope_arg() or ""
        tracker = self.work_tracker_config(cwd, scope)
        meta = {
            "label": label,
            "session_short": self.session_short(session_id),
            "scope": scope,
            "file_root": self.file_root_arg() or "",
            "cwd": cwd,
            "plugin_role": self.plugin_role(),
            "herdr_pane_id": os.environ.get("HERDR_PANE_ID")
            or os.environ.get("HERDR_PANE")
            or "",
        }
        if tracker:
            meta["work_tracker"] = tracker
        self.write_session_meta(session_id, meta)

        if source not in {"startup", "resume"} or not session_id:
            return 0

        registration_error = ""
        register_cli_args, _ = self._register_args(session_id, cwd)
        rc, out, err = self.run_swarm(register_cli_args, timeout=8.0)
        if rc == 0:
            registered = self._parse_json_object(out)
            instance_id = str(registered.get("id") or registered.get("instance_id") or "")
            if instance_id:
                scope = str(registered.get("scope") or meta.get("scope") or "")
                meta.update(
                    {
                        "instance_id": instance_id,
                        "scope": scope,
                        "file_root": str(registered.get("file_root") or meta.get("file_root") or ""),
                        "herdr_identity_published": self._publish_herdr_identity(
                            instance_id,
                            scope,
                        ),
                        "work_tracker_published": self._publish_work_tracker_config(
                            instance_id,
                            scope,
                            tracker,
                        ) if tracker else False,
                    }
                )
                self.write_session_meta(session_id, meta)
            else:
                registration_error = "register returned no instance id"
        else:
            registration_error = (err.strip() or out.strip() or f"swarm-mcp register exited {rc}")

        context = self.build_session_start_context(
            session_id,
            cwd,
            meta,
            registration_error,
        )
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

        instance_id = str(meta.get("instance_id") or "") or self._resolve_instance_id(session_id, scope)
        if instance_id:
            self._delete_herdr_identity(instance_id, scope)
            self._deregister_instance(instance_id, scope)

        if session_id:
            try:
                shutil.rmtree(self.session_scratch(session_id), ignore_errors=True)
            except Exception:
                pass
        return 0
