"""Path extraction shared by the Codex write reservation hook."""
import os
import re
from typing import Callable, Iterable

PATCH_FILE_RE = re.compile(r"^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$", re.MULTILINE)
PATCH_MOVE_RE = re.compile(r"^\*\*\*\s+Move\s+File:\s*(.+?)\s*->\s*(.+?)\s*$", re.MULTILINE)
PATCH_MOVE_TO_RE = re.compile(r"^\*\*\*\s+Move\s+to:\s*(.+?)\s*$", re.MULTILINE)


def abs_path(path: str, cwd: Callable[[], str]) -> str:
    if not path:
        return ""
    if os.path.isabs(path):
        return path
    return os.path.abspath(os.path.join(cwd(), path))


def dedupe_paths(paths: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for path in paths:
        clean = str(path or "").strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        result.append(clean)
    return result


def apply_patch_paths(patch: str, cwd: Callable[[], str]) -> list[str]:
    paths: list[str] = []
    paths.extend(abs_path(match.group(1).strip(), cwd) for match in PATCH_FILE_RE.finditer(patch))
    paths.extend(abs_path(match.group(1).strip(), cwd) for match in PATCH_MOVE_TO_RE.finditer(patch))
    for match in PATCH_MOVE_RE.finditer(patch):
        paths.append(abs_path(match.group(1).strip(), cwd))
        paths.append(abs_path(match.group(2).strip(), cwd))
    return dedupe_paths(paths)
