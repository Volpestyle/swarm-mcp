#!/usr/bin/env python3
"""SessionEnd hook -- cleanup the session's herdr identity KV and scratch dir."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import core  # noqa: E402


if __name__ == "__main__":
    try:
        sys.exit(core.run_session_end_hook(sys.stdin))
    except Exception:
        sys.exit(0)
