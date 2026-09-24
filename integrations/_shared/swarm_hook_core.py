"""Cooperative write reservations; trusted runtime launchers own session lifecycle."""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import Callable

try:
    import leased_writes
except ModuleNotFoundError:
    from . import leased_writes


@dataclass(frozen=True)
class RuntimeConfig:
    write_tools: frozenset[str]
    extract_paths: Callable[[str, object], list[str]]


class HookCore:
    def __init__(self, config: RuntimeConfig):
        self.config = config

    @staticmethod
    def session_cwd() -> str:
        return os.getcwd()

    @staticmethod
    def read_hook_input(stdin) -> dict:
        payload = json.load(stdin)
        if not isinstance(payload, dict):
            raise ValueError("Hook input must be an object")
        return payload

    @staticmethod
    def emit_block(reason: str) -> None:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))

    def run_pre_tool_use_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        tool_name = str(payload.get("tool_name") or "")
        if tool_name not in self.config.write_tools:
            return 0
        if (not leased_writes.enabled()
                or not os.environ.get("SWARM_COORDINATOR_ENDPOINT")
                or not os.environ.get("SWARM_SESSION_CAPABILITY")):
            self.emit_block("Swarm write hooks require a trusted coordinator enrollment")
            return 0
        if os.environ.get("SWARM_COORDINATOR_HOOK_OWNER") == "launcher":
            native_id = os.environ.get("SWARM_NATIVE_SESSION_ID")
            if not native_id or payload.get("session_id") != native_id:
                self.emit_block("Swarm coordinator binding belongs to another native session")
                return 0
        paths = self.config.extract_paths(tool_name, payload.get("tool_input"))
        try:
            result = leased_writes.enter(payload, paths)
            if result.get("warnings"):
                print("[swarm-mcp] logical overlap in another worktree; coordinate integration before merging", file=sys.stderr)
        except Exception as error:
            self.emit_block(f"Swarm reservation denied {tool_name}: {error}")
        return 0

    def run_post_tool_use_hook(self, stdin) -> int:
        payload = self.read_hook_input(stdin)
        if str(payload.get("tool_name") or "") in self.config.write_tools:
            try:
                leased_writes.leave(payload)
            except Exception as error:
                print(f"[swarm-mcp] reservation release failed; lease expiry/recovery remains available: {error}", file=sys.stderr)
        return 0
