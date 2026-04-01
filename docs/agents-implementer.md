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

- If there are `implement` or `fix` tasks assigned to you or open for claiming, prioritize them.
- If you have unread messages, read and act on them before starting new work.
- Note which planners and reviewers are active by checking `role:` tokens in `list_instances`.
- Check `poll_messages` and `list_tasks` periodically, not just at startup.

---

## Claim and execute tasks

When you find a task to work on:

1. `claim_task` immediately so no other session takes it.
2. `update_task` to `in_progress`.
3. `check_file` for every file you plan to edit -- look for locks, warnings, or annotations from other sessions.
4. `lock_file` with a short reason before editing.
5. Do the work.
6. `annotate` important findings on files you touched -- things a reviewer or future session needs to know.
7. `unlock_file` as soon as you are done editing.
8. `update_task` to `done` with a short `result` describing what you changed and why.

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
- `check_file` is especially important -- the other team may have locks or annotations you need to respect.
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
   - **new_messages**: Read and respond. The planner may have context, corrections, or new instructions. Messages prefixed with `[auto]` are system notifications about task assignments — act on them.
   - **task_updates**: Check for new `implement` or `fix` tasks assigned to you or open for claiming. Claim and start working immediately.
   - **instance_changes**: Note if the planner went offline. If so, check for open tasks you can still work on independently.
3. If it returns with `timeout: true` (no activity), check `list_tasks` for any open tasks you might have missed, then call `wait_for_activity` again.
4. Repeat until there are no more tasks and the planner signals completion.

**Do not return control to the user between tasks.** Your job is to continuously pick up and complete work. Only stop the loop when there is genuinely no more work to do or you are stuck and need human input.

When you complete a task with `update_task`, the requester (planner) is automatically notified via message. You do not need to separately `send_message` to inform them (though you can add detail if needed).

---

## Finish cleanly

When there are no more tasks and the planner signals completion:

1. `unlock_file` any remaining locks.
2. Call `deregister` to leave the swarm and release any remaining resources.

---

## Do not

- Start editing without calling `check_file` and `lock_file` first.
- Hold locks longer than needed -- lock one file, edit it, unlock it.
- Forget to `update_task` when you finish -- the planner is waiting on it.
- Create planning or decomposition tasks -- that is the planner's job.
