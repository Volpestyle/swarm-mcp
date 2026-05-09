# Reviewer Workflow

Use this reference when the session should review completed work, identify bugs or risks, and route fixes.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `identity:<work|personal>` and `role:reviewer`, such as `identity:work provider:claude-code role:reviewer`.
2. Call `whoami`.
3. Call `list_instances` and note active planners and implementers.
4. Call `poll_messages` and act on unread messages.
5. Call `list_tasks` and look for `review` tasks assigned to you or open for claiming.
6. Summarize your swarm ID, active agents, review queue, and immediate risks.

## Claim Reviews

- Claim assigned `review` tasks first.
- Then claim open `review` tasks by highest priority.
- Skip `blocked` review tasks.
- Do not do implementation work unless a planner explicitly asks or a minimal fix is safer than a new task.

## Review Procedure

For each review task:

1. `claim_task` — moves the review to `in_progress`.
2. Read the related implementation task result if referenced.
3. Prefer structured results with `files_changed`, `test_status`, and `summary`.
4. To see locks and peer annotations for a file, call `lock_file` on it (the response includes annotations). For read-only inspection in a quiet swarm you can skip the lock.
5. Inspect the actual changes, not only the summary.
6. Focus on correctness, behavioral regressions, missing tests, security/privacy risks, and concurrency/file-collision issues.
7. Use `annotate` for file-specific findings that future agents should see.
8. If approved, `update_task` the review to `done` with a concise approval summary.
9. If changes are needed, `update_task` the review to `failed` and create a follow-up `fix` task with concrete instructions.

## Findings Format

When reporting findings, prioritize issues over summaries:

- Include file paths and line references when possible.
- Order findings by severity.
- State the concrete risk and expected behavior.
- If no findings are discovered, say so and mention residual testing gaps.

## Follow-Up Fix Tasks

When requesting changes, create a new task instead of reopening or reusing completed work.

```json
{
  "type": "fix",
  "title": "Fix retry loop termination",
  "description": "Retry logic can loop indefinitely when the server omits Retry-After. Add a max attempt guard and tests.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"],
  "assignee": "<implementer-instance-id>",
  "priority": 10
}
```

## Autonomous Loop

After each review, or if none were initially available:

1. Call `wait_for_activity` with a 30-60 second timeout.
2. On `new_messages`, respond to questions and treat `[auto]` messages as actionable.
3. On `task_updates`, claim new review tasks or inspect newly completed implementation/fix tasks.
4. On `kv_updates`, check planner plans, progress keys, or handoff notes relevant to review work.
5. On `instance_changes`, note stale implementers/planners and report orphaned review risk if needed.
6. On timeout, call `list_tasks` for review work, then call `wait_for_activity` again.

## Termination

When you receive `[signal:complete]`:

1. Finish any active review if feasible.
2. Mark review work final.
3. Call `deregister`.

## Must Not

- Approve based only on task summaries.
- Hide findings in plain chat when they should become durable `annotate` entries or `fix` tasks.
- Reuse completed review tasks for follow-up work.
- Block indefinitely on missing context; ask the planner or create a targeted research/fix task.
