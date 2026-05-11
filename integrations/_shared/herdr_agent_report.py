"""Best-effort herdr pane agent status reporting.

Runtime hooks call this helper only when herdr injects both a pane id and an
explicit socket path. Failures are intentionally silent to keep swarm
coordination independent from the operator surface.
"""

from __future__ import annotations

import json
import os
import socket
from uuid import uuid4


_VALID_STATES = {"idle", "working", "blocked", "done", "unknown"}


def agent_source(runtime_name: str, instance_id: str = "") -> str:
    runtime = (runtime_name or "agent").strip() or "agent"
    instance = (instance_id or "").strip()
    return f"swarm-mcp:{runtime}:{instance}" if instance else f"swarm-mcp:{runtime}"


def _target() -> tuple[str, str] | None:
    pane_id = (os.environ.get("HERDR_PANE_ID") or os.environ.get("HERDR_PANE") or "").strip()
    socket_path = (os.environ.get("HERDR_SOCKET_PATH") or "").strip()
    if not pane_id or not socket_path:
        return None
    return socket_path, pane_id


def _request(method: str, params: dict[str, object], timeout: float = 1.0) -> bool:
    target = _target()
    if target is None:
        return False

    socket_path, _ = target
    request = {
        "id": f"swarm_{uuid4().hex}",
        "method": method,
        "params": params,
    }
    sock: socket.socket | None = None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(socket_path)
        sock.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))

        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break
        if not chunks:
            return False

        line = b"".join(chunks).splitlines()[0]
        response = json.loads(line.decode("utf-8"))
        return isinstance(response, dict) and "result" in response and "error" not in response
    except Exception:
        return False
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def report_agent(
    *,
    agent: str,
    state: str,
    source: str,
    message: str | None = None,
    timeout: float = 1.0,
) -> bool:
    target = _target()
    if target is None:
        return False
    _, pane_id = target

    clean_agent = (agent or "").strip()
    clean_source = (source or "").strip()
    clean_state = (state or "").strip()
    if not clean_agent or not clean_source or clean_state not in _VALID_STATES:
        return False

    params: dict[str, object] = {
        "pane_id": pane_id,
        "source": clean_source,
        "agent": clean_agent,
        "state": clean_state,
    }
    if message:
        params["message"] = message
    return _request("pane.report_agent", params, timeout=timeout)


def release_agent(
    *,
    agent: str,
    source: str,
    timeout: float = 1.0,
) -> bool:
    target = _target()
    if target is None:
        return False
    _, pane_id = target

    clean_agent = (agent or "").strip()
    clean_source = (source or "").strip()
    if not clean_agent or not clean_source:
        return False
    return _request(
        "pane.release_agent",
        {
            "pane_id": pane_id,
            "source": clean_source,
            "agent": clean_agent,
        },
        timeout=timeout,
    )
