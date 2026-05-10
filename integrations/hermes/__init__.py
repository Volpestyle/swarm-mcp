"""swarm hermes plugin — lifecycle bridge between hermes sessions and swarm-mcp.

Wires:

1. ``on_session_start`` — auto-call ``mcp_swarm_register`` so the agent does
   not spend a tool call on bootstrap. The instance id returned is cached
   per session.
2. ``on_session_finalize`` — auto-call ``mcp_swarm_deregister`` at a real
   session boundary. Hermes' ``on_session_end`` fires after every turn, so it
   is intentionally non-destructive here.
3. ``/swarm`` slash command — peek at swarm state (instances, tasks, kv,
    recent messages) without spending an agent turn. Shells to the
    ``swarm-mcp`` CLI.
4. ``pre_tool_call``/``post_tool_call`` — auto-lock write-like file tools when
   peers are active, then release those locks after the tool completes.
5. ``swarm_prompt_peer`` — send a durable swarm message and, when possible,
   wake the target workspace handle as an express lane.

The MCP server itself must be registered under the name ``swarm`` (matches
``mcp_swarm_*`` tool prefix). If a different name was used, override via
``SWARM_HERMES_MCP_NAME``.
"""

from __future__ import annotations

import logging

from . import cli, lifecycle, prompt_peer

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    ctx.register_hook("on_session_start", lifecycle.on_session_start)
    ctx.register_hook("on_session_finalize", lifecycle.on_session_finalize)
    ctx.register_hook("on_session_end", lifecycle.on_session_end)
    ctx.register_hook("pre_tool_call", lifecycle.on_pre_tool_call)
    ctx.register_hook("post_tool_call", lifecycle.on_post_tool_call)
    ctx.register_command(
        "swarm",
        handler=cli.handle_slash,
        description="Inspect swarm-mcp state (instances, tasks, kv, messages).",
        args_hint="[status|instances|tasks|kv|messages]",
    )
    ctx.register_tool(
        name="swarm_prompt_peer",
        toolset="plugin_swarm",
        schema=prompt_peer.SCHEMA,
        handler=prompt_peer.prompt_peer,
    )
    logger.info("swarm hermes plugin registered")
