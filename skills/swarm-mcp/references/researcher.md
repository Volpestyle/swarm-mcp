# Researcher Workflow

Use this reference when the session should investigate code, docs, APIs, runtime behavior, or design options without directly shipping code.

## Bootstrap

1. Call `register` with `directory` set to the current working directory and `label` including `identity:<work|personal>` and `role:researcher`, such as `identity:work provider:claude-code role:researcher`.
2. Call `bootstrap`.
3. Handle unread messages before claiming research work.
4. Note active planners, implementers, assigned research tasks, and open research tasks from the bootstrap snapshot.
5. Summarize your swarm ID, active agents, and research queue.

For most researcher sessions, this checklist plus the research task is enough: claim one research task, use read-only tools unless explicitly asked to patch, cite evidence, publish a structured result, then yield. Do not load gateway/spawn references.

## Research Procedure

For each research task:

1. `claim_task` — moves the task to `in_progress`.
2. Read the task description and clarify the expected output.
3. Investigate using read-only tools unless explicitly asked to produce a patch.
4. Use `kv_set` for structured findings other agents should be able to inspect, such as `research/<topic>` or `findings/<task-id>`.
5. `update_task` to `done` with a structured summary, evidence, and recommended next actions.

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

- Use `send_message` when a specific agent needs the finding but can pick it up at the next yield checkpoint.
- Use `prompt_peer` when a specific agent should get a live-interface nudge for the finding; it writes the durable swarm message first, then best-effort wakes the workspace handle with a short prompt to check messages.
- Broadcast only findings that affect the whole swarm.
- Do not create implementation tasks unless the planner asked researchers to do so.
- If findings imply code changes, recommend a `fix` or `implement` task in your result.

## Autonomous Loop

After completing a task, or if none were initially available:

1. Do a yield checkpoint with `bootstrap` or `poll_messages`.
2. Answer unread questions from planners, implementers, or reviewers.
3. Claim visible `research` tasks assigned to you or open for your role.
4. If you are waiting on a specific peer answer, dependency, or planner direction, call `wait_for_activity` and act on returned changes.
5. If no research responsibility remains, finish the turn and remain promptable. Do not loop just to stay warm.

## Must Not

- Edit code unless explicitly assigned implementation work.
- Present unsupported claims; include evidence references.
- Leave important findings only in chat; put them in the task result, a follow-up task, KV, or the configured tracker.
- Keep investigating indefinitely; ask a focused question or report uncertainty when blocked.
