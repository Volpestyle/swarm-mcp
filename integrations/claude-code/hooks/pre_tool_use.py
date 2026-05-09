#!/usr/bin/env python3
"""PreToolUse hook -- auto-acquire swarm locks when peers exist."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import core  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(core.run_pre_tool_use_hook(sys.stdin))
    except Exception:
        sys.exit(0)
