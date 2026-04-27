# Swarm -- Implementer

Drop-in coordination rules for an implementer session. This session claims implementation and fix tasks, edits code, and sends completed work back for review.

Copy this file into your project's `AGENTS.md` or global agent instructions for any session that should act as an implementer.

Tool names are namespaced by the host. Use whichever form your host exposes (e.g. `swarm_register`, `mcp__swarm__register`).

---

## Register

At the start of every session, call `register` before using any other swarm tool.

- `directory`: your current project directory
- `label`: include `role:implementer` (e.g. `provider:codex-cli role:implementer team:frontend`)

---

## Check for pending work

Immediately after registering, call `poll_messages`, `list_tasks`, and `list_instances`.

- If there are `implement` or `fix` tasks assigned to you or open for claiming, prioritize them. **Prefer the highest-priority task**.
- Skip tasks with `blocked` status — they are waiting on dependencies and will become `open` automatically.
- If you have unread messages, read and act on them before starting new work.
- Note which planners and reviewers are active by checking `role:` tokens in `list_instances`.
- Check `poll_messages` and `list_tasks` periodically, not just at startup.

---

## Claim and execute tasks

When you find a task to work on:

1. If `claim_task` reports unread messages, call `poll_messages` and act on planner corrections before retrying.
2. `claim_task` promptly — this also moves the task to `in_progress` for you in one call.
3. Before editing a file, call `lock_file`. Its response includes any peer annotations on that file, so a separate pre-check call is unnecessary. If `list_instances` shows you alone in scope, you can skip locking until peers join.
4. Do the work.
5. `annotate` important findings on files you touched — things a reviewer or future session needs to know.
6. `unlock_file` only if you finish a file early and want peers to edit it before the task as a whole completes.
7. `update_task` to `done` with a structured result (see below). Locks on the task's files release automatically.

### Structured results

When completing a task, include a JSON `result` so the reviewer can assess your work:

```json
{
  "files_changed": ["src/auth/middleware.ts", "src/auth/middleware.test.ts"],
  "test_status": "pass",
  "summary": "Added JWT validation middleware with 401 response for invalid tokens."
}
```

Fields:
- `files_changed`: array of file paths you modified
- `test_status`: `"pass"`, `"fail"`, or `"skipped"`
- `summary`: short description of what you did and why

If you cannot produce structured output (e.g. cannot run tests), fall back to a plain string result.

---

## Send work back for review

After completing an implementation task, create a `review` task for the planner (or reviewer):

```json
{
  "type": "review",
  "title": "Review: <short description of what you implemented>",
  "description": "<what to check, any risks or edge cases>",
  "files": ["<files you changed>"],
  "assignee": "<planner-or-reviewer-instance-id>"
}
```

Get the planner's instance ID from `list_instances`. If you don't know who reviews, omit `assignee` and let the right session claim it.

---

## Handle fix requests

If the planner rejects your work and sends a `fix` task:

- `claim_task` and treat it like a new implementation task.
- Read the planner's `result` on the failed review to understand what needs fixing.
- Follow the same lock-edit-annotate-unlock-complete cycle.
- Send another `review` task back when done.

---

## Cross-team work

If you receive a task from a session on a different team:

- Treat it the same as any other task. Scope is shared, so all tools work normally.
- Always `lock_file` before editing in cross-team work — the response surfaces locks/annotations the other team may have left.
- When done, route the `review` task back to the requester's instance ID (check the task's `requester` field or `list_instances`).

---

## Share context

- Use `annotate` for findings, warnings, or notes on files you edited. Reviewers rely on these.
- Use `broadcast` for short updates when you complete significant work.
- Use `send_message` for direct coordination with the planner or another session.

---

## Stay autonomous

After registering, checking for pending work, and completing your first task, **do not wait for user prompting**. Enter an autonomous loop:

1. After finishing a task (updating it to `done` and sending a `review` task back), immediately call `wait_for_activity` to wait for the next assignment.
2. When it returns with changes, act on them:
   - **new_messages**: Read and respond. The planner may have context, corrections, or new instructions. Messages prefixed with `[auto]` are system notifications about task assignments — act on them. If you receive a broadcast containing `[signal:complete]`, proceed to shutdown (see below).
   - **task_updates**: Check for new `implement` or `fix` tasks assigned to you or open for claiming. Prefer highest priority. Skip `blocked` tasks. Claim and start working immediately.
   - **kv_updates**: Check if the planner updated a plan or progress key relevant to your work.
   - **instance_changes**: Note if the planner went offline. If so, check for open tasks you can still work on independently.
3. If it returns with `timeout: true` (no activity), check `list_tasks` for any open tasks you might have missed, then call `wait_for_activity` again.
4. Repeat until there are no more tasks and the planner signals completion.

**Do not return control to the user between tasks.** Your job is to continuously pick up and complete work. Only stop the loop when there is genuinely no more work to do or you are stuck and need human input.

When you complete a task with `update_task`, the requester (planner) is automatically notified via message. You do not need to separately `send_message` to inform them (though you can add detail if needed).

---

## Recognize termination

When you receive a broadcast containing `[signal:complete]`:

1. Finish any task currently in progress — do not abandon mid-edit.
2. `update_task` any in-progress work to a terminal status (this also releases its file locks).
3. Call `deregister` to leave the swarm.

---

## Finish cleanly

When there are no more tasks and the planner signals completion:

1. Make sure all in-progress tasks reached a terminal `update_task` (locks release automatically).
2. Call `deregister` to leave the swarm and release any remaining resources.

---

## Do not

- Edit a file other peers may also touch without calling `lock_file` first.
- Hold locks longer than needed (terminal `update_task` releases them; use `unlock_file` for early per-file release).
- Forget to `update_task` when you finish -- the planner is waiting on it.
- Create planning or decomposition tasks -- that is the planner's job.
- Try to claim `blocked` tasks -- they will become `open` automatically when their dependencies complete.
