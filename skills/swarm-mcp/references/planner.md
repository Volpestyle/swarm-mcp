# Planner Workflow

Use this reference when the session should plan work, delegate to implementers, monitor progress, and review or route completed work.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `identity:<work|personal>` and `role:planner`, such as `identity:work provider:claude-code role:planner`.
2. Call `bootstrap`.
3. Handle unread messages before creating or claiming work.
4. Note active implementers, reviewers, researchers, peer planners, open work, blocked/failed tasks, and approval gates from the bootstrap snapshot.
5. Summarize your swarm ID, active agents, peer planners, open work, and coordination risks.

If your label includes `mode:gateway`, also load `references/gateway.md` before using `dispatch`, spawning workers, setting herdr placement, or waiting synchronously for delegated completion.

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
- Use `idempotency_key` for crash-safe retries. For tracker-backed work, prefer stable semantic keys such as `linear:VUH-20:implement`, `linear:VUH-20:review:<task-id>`, or `linear:VUH-20:fix:<failed-review-task-id>`; do not vary the key for prompt wording, harness, pane, or gateway recovery changes.
- Use `review_of_task_id` on review tasks and `fixes_task_id` on fix tasks when the related task is known.
- Make trivial, low-risk edits locally when that is clearly faster than delegation.
- Route medium or large implementation work through `dispatch` so swarm-mcp can wake or spawn a worker via the configured workspace backend. In gateway mode, follow `references/gateway.md` for placement, completion waits, and recovery.

## Work Tracker Linkage

For non-trivial work that should be visible outside swarm, load `references/work-trackers.md`.

- Use only the configured same-identity tracker for this repo/scope.
- Do not pick Linear, Jira, GitHub Issues, or any other tracker just because that MCP is loaded.
- If the configured tracker MCP is missing, create swarm tasks normally and record that tracker updates are skipped or route to a same-identity peer with the right MCP.
- Put tracker URLs or IDs in swarm task descriptions or plan KV so implementers and reviewers can report durable results back through the right path.

## Stranded Task Escalation

Planner escalation is a request, not authority. You may ask the controller to spawn a worker for a stranded task, but the controller decides whether policy, permissions, resource caps, and context allow it.

If you `request_task` and the task has not been claimed within about 30 seconds:

1. Re-read the task with `get_task`. If it is `claimed`, `in_progress`, `done`, `failed`, or `cancelled`, do not escalate.
2. Resolve the controller peer with `kv_get("clanky/controller")`.
3. If the KV entry is missing or stale, call `list_instances(label_contains="origin:clanky role:planner")` and choose the active peer in this same scope.
4. If no controller peer is found, checkpoint the task as waiting for capacity and continue your loop. Do not guess a recipient.
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
- Call `get_file_lock` on each touched file to see who is holding it. Reach for `lock_file` only to reserve a file for a planned hand-off — plugin-supported runtimes enforce peer-held locks at write time.
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

After initial setup and delegation, monitor only while you still own active coordination responsibility:

1. Call `wait_for_activity` while delegated work, dependencies, reviews, or peer questions are outstanding.
2. On `new_messages`, answer questions, unblock agents, and treat `[auto]` messages as actionable system notifications.
3. On `task_updates`, review completed tasks, handle failures, create linked fix tasks, and plan the next batch when current work is done.
4. On `kv_updates`, check implementer progress, peer planner plans, ownership changes, and `plan/latest`.
5. On `instance_changes`, assign work to new implementers and reassign orphaned work from stale agents.
6. If a configured timeout returns no changes, do one `bootstrap` checkpoint and continue waiting only if you still own active monitoring responsibility.

After a gateway restart or re-registration, recover before creating work: poll messages, read `plan/latest`, list current tasks, and treat tracker IDs in existing task titles/results as canonical unless a terminal review/failure proves a new task is needed.

Do not loop just because the swarm exists. If all delegated work is terminal and no peer answer is expected, summarize, publish final state, and idle. If a peer should get a live-interface nudge for planner feedback, use `prompt_peer`; if the peer is busy and the note can wait, use `send_message`.

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
4. Finish the turn and idle. Call `deregister` only if you are exiting or the runtime will not keep this session available.

## Manage Stale Instances

If an implementer stops responding or its heartbeat expires:

- Use `remove_instance` to force-remove it from the swarm. This releases its tasks and locks and notifies the rest of the swarm.
- Reassign its released tasks to another implementer or leave them open for claiming.

Instances become stale after roughly 30s without a heartbeat and are reclaimed after roughly 60s; use `remove_instance` only when you need the cleanup to happen now.

## Must Not

- Hold file locks unless you must edit directly.
- Create tasks for stale or unknown instance IDs.
- Reuse completed or cancelled tasks for follow-up work.
- Create tasks in another planner's owned domain without coordination.
- Overwrite a peer planner's `plan/` or `owner/` KV keys without messaging them.
- Loop forever on repeatedly failing work.
