# Implementer Workflow

Use this reference when the session should claim tasks, edit code safely, report results, and continue working autonomously.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `role:implementer`, such as `provider:claude-code role:implementer`.
2. Call `whoami`.
3. Call `list_instances` and note active planners and reviewers.
4. Call `poll_messages` and act on unread messages.
5. Call `list_tasks` and look for tasks assigned to you or open for claiming.
6. Summarize your swarm ID, active agents, and pending work.

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
3. Before editing a file, call `lock_file`. Its response includes any peer annotations on that file, so no separate `check` call is needed. Skip locking entirely when `list_instances` shows you alone in scope.
4. Make the smallest correct code changes.
5. `annotate` important findings, warnings, or follow-ups on touched files.
6. Run relevant tests or checks when feasible.
7. `unlock_file` only if you finish a file early and want peers to edit it before the task as a whole completes.
8. `update_task` to `done`, `failed`, or `cancelled` with a useful result. Locks on the task's files release automatically.
9. Create a `review` task assigned to the planner or reviewer when implementation or fix work needs review.

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

1. Call `wait_for_activity` with a 30-60 second timeout.
2. On `new_messages`, read and act. Treat `[auto]` task assignment messages as actionable.
3. On `task_updates`, claim new eligible work immediately.
4. On `kv_updates`, check planner plan changes or relevant progress/ownership updates.
5. On `instance_changes`, if the planner left, check for open tasks you can continue independently.
6. On timeout, call `list_tasks` for anything missed, then call `wait_for_activity` again.

Do not wait for user prompting between tasks. Only break the loop if genuinely stuck.

## Termination

When you receive a broadcast containing `[signal:complete]`:

1. Finish any task currently in progress.
2. `unlock_file` any remaining locks.
3. `update_task` current work to a final status.
4. Clear or update your `progress/<your-instance-id>` KV key.
5. Call `deregister`.

## Must Not

- Edit a file other peers may also touch without calling `lock_file` first.
- Hold locks longer than needed (terminal `update_task` releases them; use `unlock_file` for early per-file release).
- Forget to `update_task` when finished.
- Create planning/decomposition tasks unless the planner asked you to.
- Claim `blocked` tasks.
