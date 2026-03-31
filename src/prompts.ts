export function agents() {
  return `# Swarm

Portable coordination rules for any MCP-capable coding agent.

---

## Register early

At the start of every session, call the swarm \`register\` tool before using any other swarm tool.

If your host namespaces tools, use the variant it exposes for the \`swarm\` server.

Use your current project directory as \`directory\`. Set \`scope\` only when you want multiple worktrees or folders to share one swarm on purpose.

---

## Check first

Before starting work, call the swarm \`poll_messages\` and \`list_tasks\` tools to pick up requests from other sessions.

Before editing a file, call the swarm \`check_file\` tool for that path. If another session has a lock or warning, avoid overlap and coordinate first.

---

## Lock carefully

When you begin editing a file, call the swarm \`lock_file\` tool with a short reason.

Unlock it with the swarm \`unlock_file\` tool as soon as you are done. Keep locks short and specific.

---

## Delegate clearly

Use the swarm \`request_task\` tool for review, implementation, fix, test, or research handoffs.

Include a short title, a useful description, and relevant \`files\` when possible. Set \`assignee\` only when you want a specific active session to take it.

---

## Share context

Use the swarm \`annotate\` tool to leave findings, warnings, notes, bugs, or todos on files.

Use the swarm \`broadcast\` tool for short updates that help everyone stay in sync. Use the swarm \`send_message\` tool for direct coordination with one session.

---

## Track shared state

Use the swarm \`kv_set\` and \`kv_get\` tools for small shared state like plans, owners, or handoff notes.

Keep values short and structured. JSON strings work well when the value needs a little shape.

---

## Finish cleanly

When you complete assigned work, call the swarm \`update_task\` tool with \`in_progress\` when you start and \`done\`, \`failed\`, or \`cancelled\` when you finish.

Include a short \`result\` so the next instance can continue without re-reading everything.
`;
}

export function config() {
  return `Example MCP server configs for swarm.

Codex:

[mcp_servers.swarm]
command = "bun"
args = ["run", "/absolute/path/to/swarm-mcp/src/index.ts"]
cwd = "/absolute/path/to/swarm-mcp"

opencode:

{
  "mcp": {
    "swarm": {
      "type": "local",
      "enabled": true,
      "command": [
        "bun",
        "run",
        "/absolute/path/to/swarm-mcp/src/index.ts"
      ]
    }
  }
}

Tool names are usually namespaced by the MCP client using the server name, but the exact prefix format varies by host.`;
}

export function setup() {
  return `Register this agent session with the local swarm.

1. Call the swarm \`register\` tool with:
   - \`directory\`: current working directory
   - \`label\`: a short label if useful
   - \`scope\`: omit unless I explicitly want to share across directories
2. Call the swarm \`poll_messages\` tool
3. Call the swarm \`list_tasks\` tool
4. Summarize:
   - my swarm ID
   - other active sessions in this scope
   - open or assigned tasks
   - any immediate coordination risks`;
}

export function protocol() {
  return `Follow the shared swarm coordination protocol for this session.

- Use the swarm server tools exposed by your host
- Before editing, call the swarm \`check_file\` tool
- When editing, call the swarm \`lock_file\` tool
- When finished, call the swarm \`unlock_file\` tool
- Check the swarm \`poll_messages\` and \`list_tasks\` tools regularly
- Use the swarm \`annotate\` tool for file-specific findings
- Use the swarm \`broadcast\` tool for important progress updates
- Use the swarm \`update_task\` tool to move delegated work through \`in_progress\` to a final status`;
}
