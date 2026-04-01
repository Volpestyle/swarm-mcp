export function agents() {
  return `# Swarm

Portable coordination rules for any MCP-capable coding agent.

---

## Register early

At the start of every session, call the swarm \`register\` tool before using any other swarm tool.

If your host namespaces tools, use the variant it exposes for the \`swarm\` server.

Use your current project directory as \`directory\`. Set \`scope\` only when you want multiple worktrees or folders to share one swarm on purpose.

If you are working inside a disposable worktree but want locks and annotations to map back to a canonical checkout, set \`file_root\` to the stable path that relative file references should resolve against.

If you choose a \`label\`, prefer machine-readable tokens such as \`provider:codex-cli role:planner origin:clanky\`. Treat \`role:\` as optional. If a session has no \`role:\` token, treat it as a generalist.

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

Task creation with an assignee and task completion/failure automatically notify the relevant party via message. You do not need to separately \`send_message\` for routine task handoffs.

---

## Share context

Use the swarm \`annotate\` tool to leave findings, warnings, notes, bugs, or todos on files.

Use the swarm \`broadcast\` tool for short updates that help everyone stay in sync. Use the swarm \`send_message\` tool for direct coordination with one session.

---

## Track shared state

Use the swarm \`kv_set\` and \`kv_get\` tools for small shared state like plans, owners, or handoff notes.

Keep values short and structured. JSON strings work well when the value needs a little shape.

### Progress heartbeats

While working on a task, periodically update your status:

- Key: \`progress/<your-instance-id>\`
- Value: short summary of current activity and progress

This lets planners and other agents check on you with \`kv_list("progress/")\` without interrupting your work. Clear your progress key when you finish a task or go idle.

---

## Stay autonomous

After registering and inspecting the swarm, **do not wait for user prompting between tasks**. Use the swarm \`wait_for_activity\` tool to stay in an active loop:

1. After completing a task or when you have nothing to do, call \`wait_for_activity\`.
2. When it returns with changes, act on them immediately:
   - **new_messages**: Read and respond. Messages prefixed with \`[auto]\` are system notifications about task assignments, completions, or stale-agent recovery.
   - **task_updates**: Claim open tasks or review completed ones, depending on your role.
   - **instance_changes**: Adapt to agents joining or leaving. Assign work to newcomers or pick up orphaned tasks.
3. If it returns with \`timeout: true\`, call \`wait_for_activity\` again — or check \`list_tasks\` for anything you may have missed.
4. Repeat until the work is done.

Only break out of this loop when the overall goal is complete or you genuinely need human input.

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
  return `Register this agent session with the local swarm and begin autonomous operation.

1. Call the swarm \`register\` tool with:
   - \`directory\`: current working directory
   - \`label\`: optional, but when useful prefer machine-readable tokens such as \`provider:codex-cli role:planner\`; omit \`role:\` when this session should be a generalist
   - \`scope\`: omit unless I explicitly want to share across directories
   - \`file_root\`: omit unless I explicitly want file paths to resolve against a different canonical checkout, such as a non-temporary repo path behind a disposable worktree
2. Call the swarm \`poll_messages\` tool
3. Call the swarm \`list_tasks\` tool
4. Call the swarm \`list_instances\` tool
5. Summarize:
   - my swarm ID
   - other active sessions in this scope
   - any useful \`role:\` labels among those sessions
   - open or assigned tasks
   - any immediate coordination risks
6. Act on any pending work (claim tasks, respond to messages)
7. Enter an autonomous loop using \`wait_for_activity\` — react to new messages, task changes, and instance changes as they arrive. Do not wait for user prompting between tasks.`;
}

export function protocol() {
  return `Follow the shared swarm coordination protocol for this session.

- Use the swarm server tools exposed by your host
- Before editing, call the swarm \`check_file\` tool
- When editing, call the swarm \`lock_file\` tool
- When finished, call the swarm \`unlock_file\` tool
- When choosing collaborators, inspect \`list_instances\` labels for tokens like \`role:planner\`, \`role:reviewer\`, or \`role:implementer\`; if no \`role:\` token exists, treat that session as a generalist
- Use the swarm \`annotate\` tool for file-specific findings
- Use the swarm \`broadcast\` tool for important progress updates
- Use the swarm \`update_task\` tool to move delegated work through \`in_progress\` to a final status
- Use \`wait_for_activity\` as your idle loop instead of waiting for user prompts. React to messages, task changes, and instance changes as they arrive.
- Update your progress with \`kv_set("progress/<your-instance-id>", ...)\` while working on tasks
- Messages prefixed with \`[auto]\` are system notifications (task assignments, completions, stale-agent recovery) — act on them like any other message`;
}
