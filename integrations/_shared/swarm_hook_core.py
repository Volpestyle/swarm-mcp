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
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

try:
    import swarm_adapter_contract as contract
except ModuleNotFoundError:  # pragma: no cover - package import path for tests
    from . import swarm_adapter_contract as contract


_WARNED_MISSING_IDENTITY: set[str] = set()


def _warn_missing_identity_once(env_prefix: str) -> None:
    if env_prefix in _WARNED_MISSING_IDENTITY:
        return
    _WARNED_MISSING_IDENTITY.add(env_prefix)
    import sys

    runtime_hint = {
        "CC": "claude-code (use clawd for work, clowd for personal)",
        "CODEX": "codex (use codex for work, cdx for personal)",
    }.get(env_prefix, f"runtime with env prefix {env_prefix}")
    print(
        f"[swarm-mcp] {runtime_hint}: session has no AGENT_IDENTITY / "
        f"SWARM_{env_prefix}_IDENTITY / SWARM_IDENTITY env set. Falling back to "
        f"identity:unknown. Launch via the matching identity wrapper to get a "
        f"real identity token; bypassing the wrapper leaves the swarm boundary "
        f"undefined.",
        file=sys.stderr,
    )


@dataclass(frozen=True)
class RuntimeConfig:
    """Per-runtime knobs that parameterize HookCore.

    Attributes:
        runtime_name: Token used in derived labels, e.g. ``"claude-code"``.
        env_prefix: Used to build ``SWARM_<prefix>_*`` env-var aliases.
        scratch_dir_name: Top-level dir under ``$TMPDIR`` for per-session
            scratch (e.g. ``"swarm-cc"``).
        write_tools: Set of tool names that should trigger the pre-tool lock
            check.
        extract_paths: Function ``(tool_name, tool_input) -> [absolute_path]``.
            Receives ``tool_input`` exactly as it appears in the hook payload.
    """

    runtime_name: str
    env_prefix: str
    scratch_dir_name: str
    write_tools: frozenset[str]
    extract_paths: Callable[[str, object], list[str]]


class HookCore:
    """Runtime-agnostic hook implementation.

    Public methods come in two flavors:

    1. **Building blocks** (``swarm_cmd``, ``run_swarm``, ``derived_label``,
       ``list_locks``, ``find_peer_lock_conflict``, …) — for hook scripts
       that need fine-grained control.
    2. **Top-level hook entry points** (``run_session_start_hook``,
       ``run_pre_tool_use_hook``, ``run_post_tool_use_hook``,
       ``run_session_end_hook``) — drive the full hook lifecycle from a
       stdin file object. Plugin entry scripts can be three-line stubs that
       just call these.

    The pre-tool hook is check-only: it inspects existing locks and denies
    when a peer holds the target file. It does not acquire on behalf of the
    write tool, so ``run_post_tool_use_hook`` is a no-op kept as a stable
    entry point for plugin configs that still wire ``PostToolUse``.
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

    def _raw_identity(self) -> str:
        return (
            self._env("IDENTITY")
            or os.environ.get("SWARM_HERMES_IDENTITY")
            or os.environ.get("AGENT_IDENTITY")
            or os.environ.get("SWARM_IDENTITY")
            or ""
        ).strip()

    def resolved_identity_name(self) -> str:
        """Identity name with fallback to ``unknown``.

        Sessions launched without a matching identity wrapper (raw ``claude`` /
        ``codex`` / ``hermes`` instead of ``clawd``/``clowd`` / ``codex``/``cdx``
        / ``hermesw``/``hermesp``) miss the launcher's ``AGENT_IDENTITY``
        export and would otherwise register without any ``identity:`` token.
        Cross-identity boundary checks fail-open on missing identities, so an
        unlabeled instance is discoverable from any identity — defeating the
        boundary. We substitute ``unknown`` so the label always carries a
        distinct, non-work/non-personal identity token, then warn the operator
        once per prefix so they can fix the launcher.
        """
        derived = contract.identity_name(self._raw_identity())
        if derived:
            return derived
        _warn_missing_identity_once(self.config.env_prefix)
        return "unknown"

    def identity_token(self) -> str:
        return contract.identity_token(self.resolved_identity_name())

    def identity_name(self) -> str:
        return self.resolved_identity_name()

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
                identity=self.resolved_identity_name(),
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

    def list_locks(self, scope: Optional[str]) -> list[dict]:
        """Read-only enumeration of every active lock in scope.

        Returns the parsed ``swarm-mcp locks --json`` array, or an empty list
        on any CLI failure. The CLI's startup ``prune()`` clears stale
        instances' locks before this returns, so callers see live locks only.
        """
        args = ["locks", "--json"]
        if scope:
            args.extend(["--scope", scope])
        rc, out, _ = self.run_swarm(args, timeout=4.0)
        if rc != 0:
            return []
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return []
        return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []

    def find_peer_lock_conflict(
        self,
        scope: Optional[str],
        own_instance_id: str,
        paths: list[str],
    ) -> Optional[dict]:
        """Return the first lock row blocking ``paths``, or ``None``.

        "Blocking" means: held by an instance other than ``own_instance_id``,
        on a file in ``paths``. Same-instance locks (the agent declared a
        wider critical section earlier in the session) are not conflicts —
        the agent is free to keep editing its own reservation.
        """
        if not paths or not own_instance_id:
            return None
        target_set = set(paths)
        for row in self.list_locks(scope):
            if row.get("type") != "lock":
                continue
            if row.get("file") not in target_set:
                continue
            holder = row.get("instance_id")
            if isinstance(holder, str) and holder and holder != own_instance_id:
                return row
        return None

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

    def run_pre_tool_use_hook(self, stdin) -> int:
        """Check-only enforcement: deny when a peer holds a lock on a write target.

        The hook never acquires a lock itself. Per-edit serialization isn't the
        hazard worth catching (the race window is sub-millisecond and the
        write tool's own anchor checks defend logical conflicts); what matters
        is that a peer-declared critical section (``lock_file`` with a note)
        actually blocks other peers' writes. This hook is what enforces that.

        Same-instance locks are *not* conflicts — if this agent already
        declared a wider critical section, its own subsequent writes pass
        through normally.
        """
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
        own_instance_id = str(meta.get("instance_id") or "")
        if not own_instance_id:
            # Without a known own-id we can't distinguish own vs peer locks.
            # Coordination is opt-in; fail open.
            return 0

        conflict = self.find_peer_lock_conflict(scope, own_instance_id, paths)
        if conflict is None:
            return 0

        file = str(conflict.get("file") or "")
        holder = str(conflict.get("instance_id") or "")
        holder_short = holder[:8] if holder else "peer"
        note = str(conflict.get("content") or "").strip()
        reason = (
            f"swarm lock blocked {tool_name} for {file}: held by {holder_short}"
            + (f" ({note})" if note else "")
        )
        self.emit_block(reason)
        return 0

    def run_post_tool_use_hook(self, stdin) -> int:
        """No-op under check-only enforcement.

        The pre-tool hook never acquires a lock, so there is nothing to
        release. Kept as a stable entry point so plugin configs that still
        wire ``PostToolUse`` to this core continue to load cleanly; new
        plugin configs should omit the hook entirely.
        """
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
