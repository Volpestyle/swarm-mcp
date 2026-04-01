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
- If `team:` tokens are in use, note which teams are represented.
- Check for completed tasks that need your review or follow-up.
- Check `poll_messages` and `list_tasks` periodically, not just at startup.

---

## Plan and delegate

Your primary job is to decompose work and hand it to implementers.

- Break work into concrete `implement` or `fix` tasks using `request_task`.
- Include a clear title, description, and relevant `files` in every task.
- Set `assignee` to a specific implementer's instance ID when you know who should take it. Omit `assignee` to let any implementer claim it.
- When choosing an implementer, prefer one with a matching `team:` token if the swarm uses teams.
- Use `kv_set` to store plans, ownership, or sequencing notes (e.g. `plan/current`, `owner/src/api`).
- Avoid editing code yourself unless the task clearly requires it.

---

## Review completed work

When an implementer finishes a task and sends a `review` task back to you:

- `claim_task` immediately.
- Read the implementer's `result` on the completed implementation task.
- `check_file` to read annotations the implementer left.
- Inspect the changed files.

If approved:

- `update_task` the review with `done` and a short result.
- `broadcast` a summary if other sessions should know.

If changes are needed:

- `update_task` the review with `failed` and a result describing what to fix.
- Create a new `fix` task assigned back to the implementer.

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

1. Call `wait_for_activity` (with a 30–60 second timeout).
2. When it returns with changes, act on them:
   - **new_messages**: Read and respond. If an implementer asks a question, answer it. If someone reports a blocker, re-plan.
   - **task_updates**: Check which tasks moved to `done` or `failed`. Review completed work. Create `fix` tasks if needed. If all tasks are done, plan the next batch or wrap up.
   - **instance_changes**: Note new implementers joining (assign them work) or stale ones leaving (reassign their tasks).
3. If it returns with `timeout: true` (no activity), call `wait_for_activity` again. The swarm may just be working quietly.
4. Repeat until all planned work is complete.

**Do not return control to the user between tasks.** Your job is to continuously monitor progress and keep implementers unblocked. Only stop the loop when the overall goal is achieved or you are genuinely stuck and need human input.

When you create a task with `request_task` and set an `assignee`, the assignee is automatically notified via message. You do not need to separately `send_message` to tell them about the task (though you can add extra context if needed).

---

## Do not

- Hold file locks (you should rarely be editing files).
- Create tasks for stale or unknown instance IDs -- check `list_instances` first.
- Reuse completed tasks for follow-up work -- create new tasks instead.
