# Reviewer Workflow

Use this reference when the session should review completed work, identify bugs or risks, and route fixes.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `identity:<work|personal>` and `role:reviewer`, such as `identity:work provider:claude-code role:reviewer`.
2. Call `bootstrap`.
3. Handle unread messages before claiming review work.
4. Note active planners, implementers, assigned reviews, and open review tasks from the bootstrap snapshot.
5. Summarize your swarm ID, active agents, review queue, and immediate risks.

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
4. To see who is holding a file, call `get_file_lock` (read-only). Reviewers rarely need `lock_file` — reach for it only to reserve a file for an upcoming hand-off, not for ordinary edits (plugin-supported runtimes enforce peer-held locks at write time).
5. Inspect the actual changes, not only the summary.
6. Focus on correctness, behavioral regressions, missing tests, security/privacy risks, and concurrency/file-collision issues.
7. If approved, `update_task` the review to `done` with a concise approval summary.
8. If changes are needed, `update_task` the review to `failed` and create a follow-up `fix` task with concrete instructions.

If the review is linked to a work tracker, update it only when the review task grants that authority and the configured same-identity tracker MCP is available. Otherwise include tracker-ready findings in the swarm review result.

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

1. Do a yield checkpoint with `bootstrap` or `poll_messages`.
2. Respond to unread questions and treat `[auto]` messages as actionable.
3. Claim new review tasks when they are already visible.
4. If you are waiting on a fix, clarification, lock release, or planner response, call `wait_for_activity` and act on returned changes.
5. If no review responsibility remains, finish the turn and remain promptable. Do not loop just to stay warm.

## Termination

When you receive `[signal:complete]`:

1. Finish any active review if feasible.
2. Mark review work final.
3. Finish the turn and idle. Call `deregister` only if you are exiting or the runtime will not keep this session available.

## Must Not

- Approve based only on task summaries.
- Hide findings in plain chat when they should become `fix` tasks, tracker comments, or review results.
- Reuse completed review tasks for follow-up work.
- Block indefinitely on missing context; ask the planner or create a targeted research/fix task.
