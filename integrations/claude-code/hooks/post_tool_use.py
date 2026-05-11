#!/usr/bin/env python3
"""PostToolUse hook -- retained as a no-op back-compat shim.

The current swarm peer-lock enforcement is check-only: the PreToolUse hook inspects
peer-held locks and denies on conflict, and never acquires on the agent's
behalf, so there is nothing to release after the tool runs. This script
stays in place because already-installed Claude Code configurations may
still wire ``PostToolUse`` -> ``post_tool_use.py`` from earlier plugin
versions; new ``hooks.json`` files should omit the entry entirely.

``HookCore.run_post_tool_use_hook`` returns 0 immediately under the new
model.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import core  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(core.run_post_tool_use_hook(sys.stdin))
    except Exception:
        sys.exit(0)
