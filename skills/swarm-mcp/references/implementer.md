# Implementer Workflow

Use this reference when the session should claim tasks, edit code safely, report results, and continue working autonomously.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `identity:<work|personal>` and `role:implementer`, such as `identity:work provider:claude-code role:implementer`.
2. Call `bootstrap`.
3. Handle unread messages before claiming work.
4. Note active planners, reviewers, assigned tasks, and open tasks from the bootstrap snapshot.
5. Summarize your swarm ID, active agents, and pending work.

## Claim Priority

When tasks are available:

- Prefer tasks assigned to you.
- Then prefer open tasks matching your `team:` label.
- Then prefer any open `implement`, `fix`, or `test` task.
- Claim the highest-priority eligible task first.
- Skip `blocked` tasks; they auto-open when dependencies complete.

## Execute Safely

For each task:

1. `claim_task` — this transitions the task to `in_progress` for you in one call.
2. For long tasks only, `kv_set("progress/<your-instance-id>", ...)` with current activity.
3. Use `get_file_lock` for read-only lock inspection. Before editing a file, call `lock_file`. Skip locking entirely when `list_instances` shows you alone in scope.
4. Make the smallest correct code changes.
5. Run relevant tests or checks when feasible.
6. `unlock_file` only if you finish a file early and want peers to edit it before the task as a whole completes.
7. `update_task` to `done`, `failed`, or `cancelled` with a useful result. Normal edit locks release automatically; internal `/__swarm/` mutex locks are managed by their owning flow.
8. Create a `review` task assigned to the planner or reviewer when implementation or fix work needs review.

If the task references a work tracker, update it only when the task contract grants that authority and the configured same-identity tracker MCP is available. Otherwise put tracker-ready details in the swarm task result for the planner or gateway.

## Structured Results

Prefer a JSON `result` when completing work:

```json
{
  "files_changed": ["src/auth/middleware.ts", "src/auth/middleware.test.ts"],
  "test_status": "pass",
  "summary": "Added JWT validation middleware with 401 response for invalid tokens."
}
```

Fields:

- `files_changed`: files you modified
- `test_status`: `"pass"`, `"fail"`, or `"skipped"`
- `summary`: what changed and why

If you cannot run tests or determine file paths, say so in `test_status` or use a plain string result.

## Review Handoff

After implementation or fix work:

- Find the planner or reviewer from `list_instances`.
- Prefer an active `role:reviewer` for review tasks when available.
- Otherwise assign review back to the planner.
- Include changed files and what the reviewer should focus on.

Example review task:

```json
{
  "type": "review",
  "title": "Review retry logic change",
  "description": "Check retry loop bounds and test coverage.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"],
  "assignee": "<reviewer-or-planner-instance-id>"
}
```

## Autonomous Loop

After completing a task, or if none were initially available:

1. Do a yield checkpoint with `bootstrap` or `poll_messages`.
2. Handle unread messages before claiming more work. Treat `[auto]` task assignment messages as actionable.
3. If `bootstrap.tasks` or `list_tasks` shows eligible work, claim the highest-priority task and continue.
4. If you are waiting on a dependency, review, lock, or specific peer answer, call `wait_for_activity` and act on the returned changes.
5. If you have no active responsibility, finish the turn and remain promptable. Do not loop just to stay warm.

When a busy peer needs context, use `send_message`. When a peer should notice soon, use `prompt_peer`; it stores the durable swarm message first and usually skips interrupting actively working handles.

## Termination

When you receive a broadcast containing `[signal:complete]`:

1. Finish any task currently in progress.
2. `unlock_file` any remaining locks.
3. `update_task` current work to a final status.
4. Clear or update your `progress/<your-instance-id>` KV key.
5. Finish the turn and idle. Call `deregister` only if you are actually exiting or the runtime will not keep this session available.

## Must Not

- Edit a file other peers may also touch without calling `lock_file` first.
- Hold locks longer than needed (terminal `update_task` releases normal edit locks; use `unlock_file` for early per-file release).
- Forget to `update_task` when finished.
- Create planning/decomposition tasks unless the planner asked you to.
- Claim `blocked` tasks.
