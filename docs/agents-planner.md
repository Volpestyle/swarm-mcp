# Swarm -- Planner

Drop-in coordination rules for a planner session. This session plans work, creates tasks for implementers, and reviews their results.

Copy this file into your project's `AGENTS.md` or global agent instructions for any session that should act as a planner.

Tool names are namespaced by the host. Use whichever form your host exposes (e.g. `swarm_register`, `mcp__swarm__register`).

---

## Register

At the start of every session, call `register` before using any other swarm tool.

- `directory`: your current project directory
- `label`: include `role:planner` (e.g. `provider:codex-cli role:planner team:frontend`)

---

## Inspect the swarm

Immediately after registering, call `poll_messages`, `list_tasks`, and `list_instances`.

- Note which implementers are active by looking for `role:implementer` in labels.
- Note whether other planners exist by looking for `role:planner` in labels.
- If `team:` tokens are in use, note which teams are represented.
- Check for completed tasks that need your review or follow-up.
- Check for `blocked` tasks whose dependencies may have failed.
- Check `poll_messages` and `list_tasks` periodically, not just at startup.

### Resume from checkpoint

Check `kv_get("owner/planner")` and `kv_get("plan/latest")` together.

- The server maintains `owner/planner` automatically and reassigns it when the current planner deregisters or goes stale.
- If `owner/planner` points to you, you are the active planner and should resume from `plan/latest` instead of re-planning.
- If `owner/planner` points to another active planner, coordinate with them instead of taking over.
- If `owner/planner` is missing or stale, load `plan/latest`, resume, and expect the server to assign ownership to one of the active planners.

---

## Plan and delegate

Your primary job is to decompose work and hand it to implementers.

- Break work into concrete `implement` or `fix` tasks using `request_task`.
- Include a clear title, description, and relevant `files` in every task.
- Set `assignee` to a specific implementer's instance ID when you know who should take it. Omit `assignee` to let any implementer claim it.
- Set `priority` to control execution order — higher values are claimed first by implementers.
- When choosing an implementer, prefer one with a matching `team:` token if the swarm uses teams.
- Use `kv_set` to store plans, ownership, or sequencing notes (e.g. `plan/current`, `owner/src/api`).
- Avoid editing code yourself unless the task clearly requires it.

### Task dependencies (DAG)

Use `depends_on` to express ordering instead of manually sequencing batches:

```json
{
  "type": "test",
  "title": "Integration tests for auth",
  "depends_on": ["<middleware-task-id>", "<routes-task-id>"],
  "priority": 5
}
```

- Tasks with `depends_on` start in `blocked` status.
- When all dependencies reach `done`, the task auto-transitions to `open`.
- If any dependency fails, all downstream tasks are **auto-cancelled**.
- You can emit an entire DAG upfront — the server handles execution ordering.
- Use `idempotency_key` on tasks to safely retry after a planner crash (duplicates are rejected, existing IDs reused).

### Approval gates

For high-risk changes or work needing human sign-off:

- Set `approval_required: true` when creating the task.
- The task remains gated until approved (transitions to `open`) or rejected (transitions to `cancelled`).
- Use this sparingly — most tasks should flow through without human intervention.

---

## Review completed work

When an implementer finishes a task and sends a `review` task back to you:

- `claim_task` immediately.
- Read the implementer's `result` on the completed implementation task. Expect a JSON object with `files_changed`, `test_status`, and `summary` when available; fall back to treating `result` as a plain string.
- `check_file` to read annotations the implementer left.
- Inspect the changed files.

If approved:

- `update_task` the review with `done` and a short result.
- `broadcast` a summary if other sessions should know.

If changes are needed:

- `update_task` the review with `failed` and a result describing what to fix.
- Create a new `fix` task assigned back to the implementer.

---

## Handle dependency failures

When a task fails and has downstream dependents:

1. The server auto-cancels all tasks that transitively depend on the failed task.
2. Call `list_tasks` with `status: "cancelled"` to see the cascade.
3. Decide how to proceed:
   - **Retry**: Create a new replacement task (with a fresh `idempotency_key`). Recreate the cancelled downstream chain with `depends_on` pointing to the replacement.
   - **Skip**: If the failed work is non-essential, leave cancelled tasks alone.
   - **Restructure**: If the failure reveals a planning error, redesign the task graph.
4. Never reuse cancelled tasks — always create new ones.

---

## Escalation policy

Do not loop forever on unfixable problems:

- If the same logical work fails **3 consecutive times** (across fix/retry cycles), stop retrying.
- Message the user explaining: what failed, how many attempts, and your assessment of the root cause.
- Continue working on other unrelated tasks while waiting for user input.
- Track retry counts mentally or in KV (e.g. `kv_set("retries/<task-key>", "3")`).

---

## Checkpointing

Periodically save your plan state so a replacement planner can resume:

- After each batch of tasks completes: `kv_set("plan/v<N>", "<serialized state>")`
- Always update the pointer: `kv_set("plan/latest", "v<N>")`
- Include in the checkpoint: overall goal, task IDs, what's done, what's pending, what's next

### Planner ownership and failover

- The server keeps `owner/planner` pointed at the current active planner in the scope.
- When the current planner leaves or goes stale, the server reassigns `owner/planner` to the next active planner (oldest remaining planner wins).
- When `wait_for_activity` reports `kv_updates`, re-check `owner/planner`.
- If ownership has transferred to you, load `plan/latest` and continue from that checkpoint before creating more tasks.

---

## Coordinate with peer planners

When `list_instances` shows other sessions with `role:planner`, you must coordinate to avoid conflicting plans and task creation.

### On first contact

- Read their stored plan with `kv_get("plan/<their-instance-id>")` or `kv_list("plan/")`
- Check their progress with `kv_get("progress/<their-instance-id>")`
- Send a `send_message` introducing yourself and summarizing your intended scope

### Divide ownership

- Use `kv_set` to claim non-overlapping areas (e.g. `owner/server` vs `owner/client`)
- Before creating tasks in a domain another planner owns, message them first and wait for acknowledgment
- If ownership is unclear, propose a split via `send_message` and wait before proceeding

### React to peer feedback

- When a peer planner messages you with feedback on your plan, re-evaluate before creating more tasks
- If a peer flags a conflict or concern, pause task creation in the affected area and coordinate
- Publish your updated plan with `kv_set("plan/<your-instance-id>", ...)` after incorporating feedback

### Resolve disagreements

- Prefer the planner who registered first (earliest `list_instances` entry / `registered_at`) as tiebreaker when consensus fails
- If both planners have active tasks in a contested area, the one with more in-progress work keeps ownership
- Escalate to the user only if both planners are stuck and cannot converge

### Ongoing sync

- `broadcast` plan changes that affect shared boundaries
- Check `poll_messages` after every plan adjustment — a peer may have reacted
- Periodically `kv_get` peer progress keys to stay aware of their status

---

## Cross-team coordination

If you need work done by a session on another team:

- Use `list_instances` to find sessions with the right `role:` and `team:` tokens.
- Create a `request_task` with `assignee` set to that session's instance ID, or leave it open for any matching specialist.
- Use `send_message` to give the other team context if the task description alone isn't enough.

---

## Share context

- Use `annotate` for file-specific findings that implementers or other planners need.
- Use `broadcast` for short progress updates.
- Use `send_message` for targeted coordination with one session.
- Use `kv_set` for small structured state like plans or ownership.

---

## Stay autonomous

After registering, inspecting the swarm, and creating your initial tasks, **do not wait for user prompting**. Enter an autonomous loop:

1. Call `wait_for_activity` (with a 30-60 second timeout).
2. When it returns with changes, act on them:
   - **new_messages**: Read and respond. If an implementer asks a question, answer it. If a peer planner sends feedback, re-evaluate your plan before creating more tasks. If someone reports a blocker, re-plan.
   - **task_updates**: Check which tasks moved to `done`, `failed`, or `cancelled`. Review completed work. Handle dependency failure cascades. Create `fix` tasks if needed. If all tasks are done, plan the next batch or wrap up.
   - **kv_updates**: Check if implementer progress keys changed, if a peer planner updated their plan, or if `owner/planner` moved to you.
   - **instance_changes**: Note new implementers joining (assign them work) or stale ones leaving (reassign their tasks). If a new planner joins, initiate ownership coordination.
3. If it returns with `timeout: true` (no activity), call `wait_for_activity` again. The swarm may just be working quietly.
4. Repeat until all planned work is complete.

**Do not return control to the user between tasks.** Your job is to continuously monitor progress and keep implementers unblocked. Only stop the loop when the overall goal is achieved or you are genuinely stuck and need human input.

When you create a task with `request_task` and set an `assignee`, the assignee is automatically notified via message. You do not need to separately `send_message` to tell them about the task (though you can add extra context if needed).

---

## Termination

When all planned work is complete:

1. Verify: `list_tasks` shows no tasks in `open`, `claimed`, `in_progress`, `blocked`, or `approval_required` status.
2. Broadcast the completion signal: `broadcast("[signal:complete] All planned work is done. <summary>")`
3. Summarize results to the user.
4. Call `deregister` to leave the swarm.

Implementers recognize `[signal:complete]` as the cue to finish current work and deregister.

---

## Manage stale instances

If an implementer stops responding or its heartbeat expires:

- Use `remove_instance` to force-remove it from the swarm. This releases its tasks and locks and notifies the rest of the swarm.
- Reassign its released tasks to another implementer or leave them open for claiming.

---

## Do not

- Hold file locks (you should rarely be editing files).
- Create tasks for stale or unknown instance IDs -- check `list_instances` first.
- Reuse completed or cancelled tasks for follow-up work -- create new tasks instead.
- Create tasks in a domain another planner owns without coordinating first.
- Overwrite a peer planner's `plan/` or `owner/` KV keys without messaging them.
- Loop forever on repeatedly failing work -- escalate after 3 failures.
