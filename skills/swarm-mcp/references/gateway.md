# Gateway Workflow

Use this reference only when the session is explicitly a gateway/lead/conductor, normally labeled `mode:gateway` plus a routing role such as `role:planner`.

Ordinary workers should not spawn agents. They claim tasks, message the planner/gateway, or continue locally when safe.

## Quick Checklist

1. `bootstrap` and handle unread messages first.
2. For trivial, low-risk work, edit locally when that is clearly faster than spawning.
3. For medium or large work, create/link the configured same-identity tracker item when applicable, then call MCP `dispatch` with an explicit `idempotency_key` for retryable handoffs.
4. Use `placement` when spawning multiple workers so they land in a readable herdr layout.
5. Monitor with durable task state, not pane reads.
6. Summarize task IDs, worker identities, completion state, and where workers landed.

## Dispatch Modes

Use MCP `dispatch` inside MCP-enabled gateway sessions. Use CLI `swarm-mcp dispatch` only from hooks, scripts, operator shells, or gateway sessions where MCP tools are unavailable.

Common MCP shapes:

```json
{
  "title": "Implement retry backoff",
  "message": "Add exponential backoff and tests. Report files changed and test status.",
  "role": "implementer",
  "idempotency_key": "retry-backoff-v1"
}
```

Use an explicit `idempotency_key` for batches, retries, and user-visible work. The default key is derived from the dispatch intent; changing the title, message, type, role, or harness can create a separate task/spawn instead of observing the same handoff.

Force a fresh worker pane even when a matching live worker exists:

```json
{
  "title": "Investigate flaky launch adoption",
  "message": "Trace the adoption path and report likely root cause.",
  "role": "researcher",
  "force_spawn": true
}
```

Create/wake only, never spawn:

```json
{
  "title": "Review current changes",
  "type": "review",
  "role": "reviewer",
  "spawn": false
}
```

Common dispatch statuses:

- `dispatched`: an existing live worker was assigned and prompted.
- `spawned`: a worker was started, adopted/registering completed, and the task was bound to it.
- `spawn_in_flight`: a spawn is already underway for this intent; retry with the same `idempotency_key` to observe it.
- `no_worker`: no live worker matched and spawning was disabled.
- `spawn_failed`: the configured spawner failed before producing a worker.
- `already_terminal`: the idempotent task already reached `done`, `failed`, or `cancelled`.

## Completion Waiting

Dispatch returns after handoff/spawn by default. That is the normal background delegation behavior.

Use `completion_wait_seconds` only when the current user turn or platform wrapper needs a synchronous terminal result, for example a Telegram request that should return the worker's final answer if it completes quickly.

```json
{
  "title": "Run quick health check",
  "message": "Check the service health and report the result.",
  "role": "researcher",
  "completion_wait_seconds": 90
}
```

Interpretation:

- `completion.status = "completed"`: task reached a terminal state; inspect `completion.terminal_status` for `done`, `failed`, or `cancelled` before summarizing.
- `completion.status = "timeout"`: handoff/spawn may still be valid; tell the user it is still running and monitor through task events if you own that responsibility.
- No `completion`: dispatch returned immediately by design.

Do not use long completion waits for batches. For batch work, dispatch tasks, checkpoint the plan, then monitor with `wait_for_activity` while you still own active coordination responsibility.

## Herdr Placement

When spawning through herdr, keep workers grouped and readable.

`placement` is used only when dispatch actually spawns a pane. If dispatch reuses a live worker, placement does not move that worker. For batch layouts where fresh panes are intentional, use `force_spawn: true` with `placement`.

Default policy:

- Same `identity + scope + cwd` reuses one workspace.
- Same `placement.group` reuses a tab until the pane cap is reached.
- Default cap is 3 panes per tab unless the operator prefers denser layout.
- Different repos/cwds should usually get separate workspaces.

Use `placement` for batches:

```json
{
  "title": "Implement API validation",
  "message": "Add validation for the assigned endpoint and tests.",
  "role": "implementer",
  "force_spawn": true,
  "placement": {
    "group": "api-validation",
    "max_panes_per_tab": 3,
    "split_direction": "right"
  }
}
```

Use an explicit parent only when the operator or visible context points to a specific pane:

```json
{
  "title": "Pair next to gateway",
  "role": "implementer",
  "placement": {
    "parent_pane_id": "<current-herdr-pane>",
    "split_direction": "down"
  }
}
```

Never treat herdr pane IDs as durable coordination identity. Use returned pane/workspace metadata only for operator summaries and best-effort wakeups; tasks, messages, locks, and results target swarm `instance_id`.

## Batch Pattern

For 2-6 related workers:

1. Choose a short `placement.group`, such as `vuh-batch` or `api-validation`.
2. Dispatch each task with the same `placement.group` and `max_panes_per_tab`.
3. Use dependencies for ordered work instead of asking workers to wait in chat.
4. Save a plan checkpoint with task IDs and expected outputs.
5. Use `wait_for_activity` only while you still own active monitoring.
6. When all tasks are terminal, broadcast `[signal:complete]` and summarize.

Checkpoint in KV so another gateway/planner can recover, for example `kv_set("plan/latest", "<serialized plan with task IDs, owners, expected outputs, and next step>")`.

## Recovery

If dispatch says `spawn_in_flight`:

- Check the returned `task_id`, `expected_instance`, `launch_token`, and `workspace_handle`.
- The task may still be open while the worker starts. Do not duplicate the spawn with a new idempotency key unless you intentionally want another worker.
- Re-run dispatch with the same `idempotency_key` to observe the same in-flight handoff. If you omitted the key, keep the dispatch intent unchanged so the auto-derived key remains stable.

If a pane exists but no worker claims the task:

1. Check `list_instances` for the expected adopted worker.
2. Check `get_task` for open/claimed/in-progress state.
3. Treat open/unassigned task plus no adopted worker as spawn/bootstrap failure.
4. Use herdr pane reads only for diagnosis, not as proof of task completion.
5. If needed, prompt the operator or file a spawner/backend bug with the task id, launch token, and workspace metadata.

If a live worker is busy:

- Prefer `send_message` for non-urgent context.
- Use `prompt_peer` when the worker should get a live-interface nudge; it records the durable message first and best-effort wakes the handle with a short prompt to check messages.
- Use `force=true` only for urgent, corrective, or blocking updates.

## User Summary

After dispatching or monitoring, report:

- Task IDs and roles.
- Whether work was handed to a live worker, spawned, still in flight, or completed.
- Any worker result or timeout.
- Human-readable placement when available, such as `herdr workspace/tab/pane metadata returned`, without relying on raw pane IDs as durable identity.

## Must Not

- Spawn from ordinary worker/generalist sessions.
- Use native subagents as the gateway fallback for medium/large human-trackable work.
- Scrape pane output as the completion contract.
- Fire duplicate spawns with new idempotency keys when an existing spawn is still in flight.
- Cross `identity:work` / `identity:personal` boundaries for delegation or spawned workers.
