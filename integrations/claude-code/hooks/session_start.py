#!/usr/bin/env python3
"""SessionStart hook -- register the agent with swarm-mcp."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import core  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(core.run_session_start_hook(sys.stdin))
    except Exception:
        sys.exit(0)
