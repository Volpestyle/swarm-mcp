export function agents() {
  return `# Swarm

Portable coordination rules for any MCP-capable coding agent.

---

## Register early

At the start of every session, call the swarm \`register\` tool before using any other swarm tool.

If your host namespaces tools, use the variant it exposes for the \`swarm\` server.

Use your current project directory as \`directory\`. Set \`scope\` only when you want multiple worktrees or folders to share one swarm on purpose. Do not use \`scope\` to split frontend/backend inside one repo; use label tokens like \`team:frontend\` instead.

If you are working inside a disposable worktree but want locks and annotations to map back to a canonical checkout, set \`file_root\` to the stable path that relative file references should resolve against.

If you choose a \`label\`, prefer machine-readable tokens such as \`provider:codex-cli role:planner origin:clanky\`. Treat \`role:\` as optional. If a session has no \`role:\` token, treat it as a generalist.

---

## Check first

Before starting work, call the swarm \`poll_messages\` and \`list_tasks\` tools to pick up requests from other sessions. Prefer the highest-priority open task when claiming work. Skip \`blocked\` tasks — they will become \`open\` automatically when their dependencies complete.

Before editing a file, call the swarm \`check_file\` tool for that path. If another session has a lock or warning, avoid overlap and coordinate first.

---

## Lock carefully

When you begin editing a file, call the swarm \`lock_file\` tool with a short reason.

Unlock it with the swarm \`unlock_file\` tool as soon as you are done. Keep locks short and specific.

---

## Delegate clearly

Use the swarm \`request_task\` tool for review, implementation, fix, test, or research handoffs.

Include a short title, a useful description, and relevant \`files\` when possible. Set \`assignee\` only when you want a specific active session to take it.

Use \`priority\` to control execution order — higher values are claimed first. Use \`depends_on\` with task IDs to express ordering — dependent tasks stay \`blocked\` until all dependencies reach \`done\`. If a dependency fails, downstream tasks are auto-cancelled.

Use \`request_task_batch\` to create multiple tasks atomically in a single transaction. Use \`$N\` references (1-indexed) for dependencies between tasks in the batch.

Use \`idempotency_key\` to prevent duplicate task creation on retry after a crash.

Use explicit \`review\` tasks for normal code review handoff. Reserve \`approval_required\` for true approval gates.

Task creation with an assignee and task completion/failure automatically notify the relevant party via message. You do not need to separately \`send_message\` for routine task handoffs.

---

## Share context

Use the swarm \`annotate\` tool to leave findings, warnings, notes, bugs, or todos on files.

Use the swarm \`broadcast\` tool for short updates that help everyone stay in sync. Use the swarm \`send_message\` tool for direct coordination with one session.

---

## Track shared state

Use the swarm \`kv_set\` and \`kv_get\` tools for small shared state like plans, owners, or handoff notes.

For planner sessions, the server maintains \`owner/planner\` automatically. Use it to tell whether you are the active planner and to detect failover.

Keep values short and structured. JSON strings work well when the value needs a little shape.

If your host compacts context or you start a fresh window, call \`register\` again and rehydrate from \`poll_messages\`, \`list_tasks\`, \`list_instances\`, and any role-specific KV keys you rely on. The shared database is the durable source of truth.

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
   - **new_messages**: Read and respond. Messages prefixed with \`[auto]\` are system notifications about task assignments, completions, or stale-agent recovery. If you receive a \`[signal:complete]\` broadcast, the planner is signaling all work is done — finish current work and deregister.
   - **task_updates**: Claim the highest-priority open task or review completed ones, depending on your role. Check \`failed\` and \`cancelled\` tasks too so you can react to cascades. Skip \`blocked\` tasks.
   - **kv_updates**: Check for plan changes, progress updates, or planner ownership handoffs from other agents.
   - **instance_changes**: Adapt to agents joining or leaving. Assign work to newcomers or pick up orphaned tasks.
3. If it returns with \`timeout: true\`, call \`wait_for_activity\` again — or check \`list_tasks\` for anything you may have missed.
4. Repeat until the work is done.

Only break out of this loop when the overall goal is complete or you genuinely need human input.

---

## Finish cleanly

When you complete assigned work, call the swarm \`update_task\` tool with \`in_progress\` when you start and \`done\`, \`failed\`, or \`cancelled\` when you finish.

Include a structured \`result\` when possible — a JSON string with \`files_changed\`, \`test_status\`, and \`summary\` — so the reviewer can assess your work. Fall back to a plain string if structured output is not feasible.
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
   - \`scope\`: omit unless I explicitly want to share across directories or worktrees; do not use it to split frontend/backend inside one repo
   - \`file_root\`: omit unless I explicitly want file paths to resolve against a different canonical checkout, such as a non-temporary repo path behind a disposable worktree
2. Call the swarm \`poll_messages\` tool
3. Call the swarm \`list_tasks\` tool — note open, blocked, and assigned tasks
4. Call the swarm \`list_instances\` tool
5. Check \`kv_get("owner/planner")\` and \`kv_get("plan/latest")\`. If \`owner/planner\` points to you, or no active planner owner exists, resume from the latest checkpoint instead of re-planning from scratch.
6. Summarize:
   - my swarm ID
   - other active sessions in this scope
   - any useful \`role:\` labels among those sessions
   - open, blocked, or assigned tasks (claim highest priority first)
   - whether you currently own \`owner/planner\`
   - any immediate coordination risks
7. Act on any pending work (claim tasks, respond to messages)
8. Enter an autonomous loop using \`wait_for_activity\` — react to new messages, task changes, KV updates, and instance changes as they arrive. Do not wait for user prompting between tasks.

If this host later compacts context or starts a fresh window, repeat this same rehydration flow instead of relying on remembered prompt text.`;
}

const ROLE_BOOTSTRAPS: Record<string, string> = {
  planner: `You are a **planner** in this swarm.

Your job is to decompose work, delegate to specialists, and keep the swarm productive — not to write code yourself unless no implementer is available.

1. Call \`list_instances\` — note active implementers (\`role:implementer\`), reviewers (\`role:reviewer\`), and other planners (\`role:planner\`).
2. Check \`kv_get("owner/planner")\`. If it points to you, load \`kv_get("plan/latest")\` and resume; otherwise wait for the user's goal.
3. Break the goal into tasks via \`request_task\` / \`request_task_batch\`. Use explicit \`review\` tasks for code review handoff. Use \`approval_required\` only for human approval gates, not routine review.
4. Use \`broadcast\` for swarm-wide updates and \`send_message\` for direct coordination.
5. Enter the \`wait_for_activity\` loop and react to task completions, failures, and messages. When all work is done, broadcast \`[signal:complete]\`.`,

  implementer: `You are an **implementer** in this swarm.

Your job is to claim and execute coding tasks assigned by planners.

1. Call \`list_tasks\` and \`poll_messages\` — claim the highest-priority \`open\` task that matches your role (or is unassigned). Skip \`blocked\` tasks.
2. Before editing a file, call \`check_file\`. Then \`lock_file\` with a short reason while you work; \`unlock_file\` as soon as you're done.
3. Update progress with \`kv_set("progress/<your-instance-id>", "...")\` while working.
4. On completion, call \`update_task\` with \`done\` (or \`failed\`/\`cancelled\`) and a structured \`result\` JSON: \`{ "files_changed": [...], "test_status": "...", "summary": "..." }\`.
5. After implementation or fix work, create a \`review\` task for the planner or reviewer instead of relying on passive scans.
6. Enter the \`wait_for_activity\` loop and claim the next task as soon as it appears. Do not wait for user prompts between tasks.`,

  reviewer: `You are a **reviewer** in this swarm.

Your job is to review work handed to you through explicit \`review\` tasks — read diffs, check correctness, and either approve or request changes.

1. Call \`list_tasks\` — look for \`review\` tasks assigned to you or open for claiming.
2. Read the implementation task result (files_changed, test_status, summary) and inspect the actual changes. Use \`annotate\` to leave file-specific findings.
3. Approve the \`review\` task via \`update_task\` with \`done\`, or push back by failing the \`review\` task and creating a follow-up \`fix\` task.
4. Use \`broadcast\` for cross-cutting concerns spotted during review.
5. Enter the \`wait_for_activity\` loop and react to new completions.`,

  researcher: `You are a **researcher** in this swarm.

Your job is to investigate questions, explore codebases, and produce findings other agents can act on — not to ship code yourself.

1. Call \`list_tasks\` — look for \`research\` type tasks or tasks assigned to you.
2. Investigate using read-only tools. Use \`annotate\` to leave findings on relevant files. Use \`kv_set\` for structured findings other agents can read.
3. On completion, call \`update_task\` with \`done\` and a structured \`result\` summarizing what you found and where.
4. Enter the \`wait_for_activity\` loop and pick up the next research task.`,
};

export function roleBootstrap(role: string | null | undefined) {
  if (!role) return "";
  return ROLE_BOOTSTRAPS[role.trim().toLowerCase()] ?? "";
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
- Use \`priority\` to control task execution order — higher values are claimed first
- Use \`depends_on\` to express task ordering — dependent tasks stay \`blocked\` until all dependencies complete
- Use \`request_task_batch\` to create multiple tasks atomically with \`$N\` dependency references
- Use explicit \`review\` tasks for code review handoff. Reserve \`approval_required\` for true approval gates
- Use \`wait_for_activity\` as your idle loop instead of waiting for user prompts. React to messages, task changes, KV updates, and instance changes as they arrive.
- If you are a planner, watch \`owner/planner\` on \`kv_updates\`. When ownership transfers to you, load \`plan/latest\` and resume.
- Update your progress with \`kv_set("progress/<your-instance-id>", ...)\` while working on tasks
- Messages prefixed with \`[auto]\` are system notifications (task assignments, completions, stale-agent recovery) — act on them like any other message
- When you receive a broadcast containing \`[signal:complete]\`, the planner is signaling all work is done — finish current work and deregister
- When completing tasks, prefer a structured JSON result: \`{ "files_changed": [...], "test_status": "pass", "summary": "..." }\``;
}
