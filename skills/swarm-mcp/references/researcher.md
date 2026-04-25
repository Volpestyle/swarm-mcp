# Researcher Workflow

Use this reference when the session should investigate code, docs, APIs, runtime behavior, or design options without directly shipping code.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `role:researcher`, such as `provider:claude-code role:researcher`.
2. Call `whoami`.
3. Call `list_instances` and note active planners and implementers.
4. Call `poll_messages` and act on unread messages.
5. Call `list_tasks` and look for `research` tasks assigned to you or open for claiming.
6. Summarize your swarm ID, active agents, and research queue.

## Research Procedure

For each research task:

1. `claim_task`.
2. `update_task` to `in_progress`.
3. Read the task description and clarify the expected output.
4. Investigate using read-only tools unless explicitly asked to produce a patch.
5. Use `annotate` for file-specific findings, warnings, bugs, or todos.
6. Use `kv_set` for structured findings other agents should be able to inspect, such as `research/<topic>` or `findings/<task-id>`.
7. `update_task` to `done` with a structured summary, evidence, and recommended next actions.

## Result Format

Prefer JSON when completing research:

```json
{
  "summary": "What was learned.",
  "evidence": ["src/foo.ts:42", "docs/bar.md"],
  "risks": ["Known limitation or uncertainty."],
  "recommendations": ["Concrete next action for planner or implementer."]
}
```

## Coordination

- Send direct messages when a specific agent needs the finding immediately.
- Broadcast only findings that affect the whole swarm.
- Do not create implementation tasks unless the planner asked researchers to do so.
- If findings imply code changes, recommend a `fix` or `implement` task in your result.

## Autonomous Loop

After completing a task, or if none were initially available:

1. Call `wait_for_activity` with a 30-60 second timeout.
2. On `new_messages`, answer questions from planners/implementers.
3. On `task_updates`, claim new `research` tasks assigned to you or open.
4. On `kv_updates`, check relevant research handoffs or planner plan changes.
5. On `instance_changes`, note if the planner left and avoid creating new work unless requested.
6. On timeout, call `list_tasks` for research work, then call `wait_for_activity` again.

## Must Not

- Edit code unless explicitly assigned implementation work.
- Present unsupported claims; include evidence references.
- Leave important file-specific findings only in task text; use `annotate` where appropriate.
- Keep investigating indefinitely; ask a focused question or report uncertainty when blocked.
