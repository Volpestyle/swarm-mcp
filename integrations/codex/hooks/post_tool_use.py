#!/usr/bin/env python3
"""Release coordinator reservations for a native write tool."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import core

if __name__ == "__main__":
    try:
        sys.exit(core.run_post_tool_use_hook(sys.stdin))
    except Exception as error:
        print(f"Swarm reservation hook failed: {error}", file=sys.stderr)
        sys.exit(2)
