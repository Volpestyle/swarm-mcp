#!/usr/bin/env python3
"""PreToolUse hook -- auto-acquire swarm locks for apply_patch when peers exist."""

from __future__ import annotations

import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import core  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(core.run_pre_tool_use_hook(sys.stdin))
    except Exception as error:
        if os.environ.get("SWARM_COORDINATOR_CLIENT"):
            print(f"swarm reservation hook failed: {error}", file=sys.stderr)
            sys.exit(2)
        sys.exit(0)
