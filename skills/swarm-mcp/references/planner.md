# Planner Workflow

Use this reference when the session should plan work, delegate to implementers, monitor progress, and review or route completed work.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `role:planner`, such as `provider:claude-code role:planner`.
2. Call `whoami`.
3. Call `list_instances` and note active implementers, reviewers, researchers, and peer planners.
4. Call `poll_messages` and act on unread messages.
5. Call `list_tasks` and check for review work, follow-ups, blocked tasks, failed tasks, and approval gates.
6. Summarize your swarm ID, active agents, peer planners, open work, and coordination risks.

## Ownership

The server maintains `owner/planner` automatically.

- If `owner/planner` points to you, you own swarm-wide planner duties.
- If it points to another active planner, coordinate instead of taking over.
- If it is missing or stale, load `plan/latest` and be ready to resume once ownership transfers.

## Plan And Delegate

- Break work into concrete `implement`, `fix`, `test`, `research`, or `review` tasks with `request_task` or `request_task_batch`.
- Include clear titles, descriptions, relevant `files`, and acceptance criteria.
- Assign work only to active instance IDs from `list_instances`.
- Use `priority`; higher values are claimed first.
- Use `depends_on` to express ordering. Tasks with unmet dependencies start as `blocked` and auto-open when dependencies complete.
- Use `idempotency_key` for crash-safe retries.
- Avoid editing code yourself unless necessary.

## Stranded Task Escalation

Planner escalation is a request, not authority. You may ask the controller to spawn a worker for a stranded task, but the controller decides whether policy, permissions, resource caps, and context allow it.

If you `request_task` and the task has not been claimed within about 30 seconds:

1. Re-read the task with `get_task`. If it is `claimed`, `in_progress`, `done`, `failed`, or `cancelled`, do not escalate.
2. Resolve the controller peer with `kv_get("clanky/controller")`.
3. If the KV entry is missing or stale, call `list_instances(label_contains="origin:clanky role:planner")` and choose the active peer in this same scope.
4. If no controller peer is found, annotate or checkpoint the task as waiting for capacity and continue your loop. Do not guess a recipient.
5. Send the controller a versioned JSON message:

```json
{
  "v": 1,
  "kind": "spawn_request",
  "taskId": "<task-id>",
  "role": "implementation",
  "reason": "Task unclaimed after 30s"
}
```

Allowed `role` values are `implementation`, `review`, and `research`. Do not include `cwd`, `harness`, shell commands, or any other spawn parameter; the controller derives where and how to spawn from your own registered context. Continue your loop after sending the request. The controller may spawn a worker, decline, ask the operator, or do nothing if caps are exhausted.

## Task DAGs

Prefer a task graph over manually staged batches.

```json
{
  "type": "implement",
  "title": "Add auth routes",
  "depends_on": ["<middleware-task-id>"],
  "priority": 5
}
```

- If any dependency fails, downstream dependent tasks are auto-cancelled.
- When handling a dependency failure, call `list_tasks` with `status: "cancelled"` to find the cascade.
- Do not reuse cancelled tasks. Create replacement tasks with new IDs and dependencies.

## Approval Gates

Use `approval_required` only for true human or high-risk approval checkpoints, not routine code review.

- When approved, the task transitions to `open`.
- If work should not proceed, cancel it explicitly.

## Peer Planners

When other `role:planner` sessions are active:

- Read their plans with `kv_get("plan/<their-instance-id>")` or `kv_list("plan/")`.
- Check progress with `kv_get("progress/<their-instance-id>")`.
- Introduce yourself via `send_message` and summarize your intended ownership area.
- Divide ownership with `kv_set("owner/<area>", ...)`, such as `owner/server` and `owner/client`.
- Before creating tasks in a domain another planner owns, message them first.
- If consensus fails, prefer the planner who registered first as tiebreaker.

## Review Completed Work

When an implementer sends a `review` task:

- `claim_task` — this moves the review to `in_progress`.
- Read the implementation task `result`; prefer structured JSON with `files_changed`, `test_status`, and `summary`.
- Call `lock_file` on each touched file you want to inspect; the response includes peer annotations. (You can skip locking if you're only reading and other peers aren't actively editing.)
- Inspect the actual changes.
- If approved, `update_task` the review to `done`.
- If changes are needed, `update_task` the review to `failed` and create a follow-up `fix` task.

## Checkpointing

Save plan state so another planner can recover:

- After creating each batch or DAG: `kv_set("plan/v<N>", "<serialized plan state>")`.
- Always update the pointer: `kv_set("plan/latest", "v<N>")`.
- Publish your current planner-local plan: `kv_set("plan/<your-instance-id>", "<serialized plan state>")`.
- Include the goal, task IDs, completed work, pending work, ownership areas, and next step.

Example checkpoint:

```json
{
  "goal": "Add authentication system",
  "version": 3,
  "batches": [
    { "tasks": ["id-1", "id-2"], "status": "done" },
    { "tasks": ["id-3", "id-4", "id-5"], "status": "in_progress" }
  ],
  "next": "Integration tests after auth routes complete"
}
```

## Autonomous Loop

After initial setup and delegation, loop until the goal is complete:

1. Call `wait_for_activity` with a 30-60 second timeout.
2. On `new_messages`, answer questions, unblock agents, and treat `[auto]` messages as actionable system notifications.
3. On `task_updates`, review completed tasks, handle failures, create fix tasks, and plan the next batch when current work is done.
4. On `kv_updates`, check implementer progress, peer planner plans, ownership changes, and `plan/latest`.
5. On `instance_changes`, assign work to new implementers and reassign orphaned work from stale agents.
6. On timeout, call `wait_for_activity` again.

Do not wait for user prompting between iterations. Only break the loop for questions you genuinely cannot answer yourself.

## Escalation

- If the same logical work fails 3 consecutive times, stop creating retry tasks.
- Explain what failed, how many attempts were made, and what you think the issue is.
- Wait for user input before retrying that specific work.
- Continue unrelated work while waiting.
- Track retry counts mentally or in KV, such as `kv_set("retries/<task-key>", "3")`.

## Termination

When all planned work is complete:

1. Call `list_tasks` and verify no tasks are `open`, `claimed`, `in_progress`, `blocked`, or `approval_required`.
2. Broadcast `"[signal:complete] All planned work is done. <summary>"`.
3. Summarize results to the user.
4. Call `deregister`.

## Must Not

- Hold file locks unless you must edit directly.
- Create tasks for stale or unknown instance IDs.
- Reuse completed or cancelled tasks for follow-up work.
- Create tasks in another planner's owned domain without coordination.
- Overwrite a peer planner's `plan/` or `owner/` KV keys without messaging them.
- Loop forever on repeatedly failing work.
