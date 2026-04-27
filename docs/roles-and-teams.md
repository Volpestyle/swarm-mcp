# Roles And Teams

This guide shows how to run a specialist swarm with `swarm-mcp`.

The important model is:

- `swarm-mcp` gives you discovery, messaging, task handoff, file locks, annotations, and shared KV.
- Roles and teams are conventions layered on top of those tools.
- The server does not enforce role semantics. Your agents learn them through `AGENTS.md`, prompts, or an orchestrator.

## What Is Native

`scope`, `label`, `request_task`, and `kv_*` are first-class server features. `role` and `team` are not -- they are conventions encoded in labels and KV values. Your agents learn them through `AGENTS.md`, prompts, or an orchestrator.

See the README's [Registration fields](../README.md#registration-fields) for full field documentation.

## Recommended Label Format

Use machine-readable, space-separated tokens:

```
provider:codex-cli role:planner
provider:codex-cli role:implementer team:frontend
provider:claude-code role:reviewer
```

- `role:` is optional. No `role:` token means generalist.
- Keep tokens short and unambiguous. Prefer one clear role token.
- Add `team:`, `origin:`, or `owner:` tokens when useful.

## Recommended Role Meanings

These are social contracts, not server rules.

### Planner

Use `role:planner` for sessions that should:

- decompose work into task DAGs using `depends_on` and `priority`
- create tasks with `idempotency_key` for crash-safe retries
- coordinate implementers and reviewers
- keep shared plans in `kv_set` and checkpoint periodically for crash recovery
- handle dependency failure cascades (downstream tasks are auto-cancelled)
- escalate to the user after 3 consecutive failures on the same work
- broadcast `[signal:complete]` when all work is done
- avoid editing code unless the task clearly requires it

### Implementer

Use `role:implementer` for sessions that should:

- claim the highest-priority open implementation or fix tasks
- skip `blocked` tasks (they auto-unblock when dependencies complete)
- lock files before editing
- annotate important findings on touched files
- report structured results: `{ files_changed, test_status, summary }`
- recognize `[signal:complete]` as the cue to finish and deregister

### Reviewer

Use `role:reviewer` for sessions that should:

- inspect changes and risks
- run or suggest verification
- annotate bugs, regressions, or follow-up work
- avoid becoming the primary implementer unless explicitly redirected

### Researcher

Use `role:researcher` for sessions that should:

- investigate docs, logs, APIs, or unfamiliar code paths
- summarize findings for planners or implementers
- avoid speculative edits unless asked

### Generalist

Use no `role:` token for sessions that should:

- pick up overflow work
- fill gaps when no specialist is available
- handle mixed tasks pragmatically

## Teams

There are two useful team models.

### Hard Teams: Separate Scopes

Use a different `scope` for each separate swarm.

Examples:

- `scope = C:\\repo-a`
- `scope = C:\\repo-b`
- `scope = product-alpha`
- `scope = product-beta`

Use this when you want strong isolation. Sessions in different scopes cannot see each other, message each other, or share tasks and locks.

### Soft Teams: Same Scope, Label Conventions

Keep one shared `scope`, but add a team token to labels:

- `provider:codex-cli role:implementer team:frontend`
- `provider:claude-code role:reviewer team:api`
- `provider:codex-cli role:planner team:platform`

Use this when everyone should stay in one shared swarm but still advertise specialties or sub-groups. Because all sessions share one scope, every tool works across teams -- messaging, tasks, locks, annotations, and KV are all visible to everyone.

#### Routing heuristic

Because `team:` is only a convention, your instructions should say how to use it:

1. Prefer a same-team specialist (matching `team:` and `role:`)
2. Fall back to any specialist with matching `role:` on another team
3. Fall back to a generalist (no `role:` token)

#### Multi-team same-scope example

Two teams (frontend and api) sharing one swarm, each with a planner + implementer pair. The planners also handle review.

| Session | Label |
|---------|-------|
| Frontend planner | `role:planner team:frontend` |
| Frontend implementer | `role:implementer team:frontend` |
| API planner | `role:planner team:api` |
| API implementer | `role:implementer team:api` |

**Within-team flow** -- same as the two-session pattern:

1. Frontend planner creates `implement` task -> frontend implementer claims it
2. Frontend implementer finishes, creates `review` task assigned to frontend planner
3. Frontend planner reviews, approves or sends `fix` task back

**Cross-team handoff** -- when frontend needs an API change:

1. Frontend planner creates a task for the API team:

```json
{
  "type": "implement",
  "title": "Add pagination to /api/users endpoint",
  "description": "Frontend needs cursor-based pagination. Add limit/cursor params.",
  "files": ["src/api/users.ts"]
}
```

The frontend planner has two options:

- Set `assignee` to the API planner's instance ID (found via `list_instances`) to let the API planner decompose and delegate it within their team
- Set `assignee` to the API implementer directly if the task is small and self-contained
- Omit `assignee` to let any available session claim it

2. The API planner or implementer claims the task, does the work, and marks it `done` with a result.
3. The frontend planner sees the completed task via `list_tasks` or `poll_messages` and can create a `review` task if needed.

**Cross-team messaging** -- for lightweight coordination that doesn't need task tracking:

- Use `send_message` to ask a specific session a question
- Use `broadcast` when something affects all teams (e.g. "schema migration is running, hold off on DB changes")

#### Cross-team AGENTS.md addition

Add this to your `AGENTS.md` when using multiple teams in one scope:

```md
## Cross-Team Coordination

- All teams share one swarm. You can see, message, and delegate to any session.
- Use `list_instances` to find sessions by `role:` and `team:` tokens.
- For cross-team work, prefer assigning to the other team's planner so they can decompose it.
- For small cross-team requests, assign directly to an implementer.
- Use `send_message` to give the other team context that doesn't fit in the task description.
```

## Shared State Conventions

Use `kv_set` for small structured team state.

Good examples:

- `plan/current`
- `owner/src/api/users.ts`
- `handoff/reviewer`
- `team/frontend/status`

JSON strings work well:

```json
{
  "lead": "swarm-instance-123",
  "status": "blocked",
  "blocked_on": "schema review"
}
```

Do not treat KV as a database for large transcripts. Keep it short and operational.

## Example Workflows

### Three-session: planner + implementer + reviewer

The classic specialist loop in 6 steps.

#### 1. Register the sessions

Each session calls `register` with the same `scope` and `directory`, using different labels:

| Session | Label |
|---------|-------|
| Planner | `provider:codex-cli role:planner` |
| Implementer | `provider:codex-cli role:implementer` |
| Reviewer | `provider:claude-code role:reviewer` |

#### 2. Inspect the swarm

Each session calls `whoami`, `list_instances`, `poll_messages`, and `list_tasks`. The planner identifies active specialists by `role:` tokens.

#### 3. Planner creates implementation work

```json
{
  "type": "implement",
  "title": "Add retry logic to API client",
  "description": "Handle transient 429 and 503 responses in src/api/client.ts.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"],
  "priority": 10
}
```

Set `assignee` to a known instance ID for direct assignment, or omit it for any implementer to claim. Set `priority` to control execution order (higher = claimed first). Use `depends_on` with task IDs to express ordering constraints.

#### 4. Implementer picks up the task

`claim_task` (highest priority first; transitions to `in_progress`) -> `lock_file` (returns peer annotations as part of the response) -> do the work -> `annotate` findings -> `update_task` with `done` and a structured result (`{ files_changed, test_status, summary }`). Locks on the task's files release automatically; use `unlock_file` only for early per-file release.

#### 5. Planner requests review

```json
{
  "type": "review",
  "title": "Review retry logic change",
  "description": "Check for retry loops and missing coverage.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"]
}
```

#### 6. Reviewer completes review

Inspect the task, call `lock_file` on the changed files (the response includes the implementer's annotations), add `annotate` notes for risks or follow-ups, then `update_task` with `done`, `failed`, or `cancelled`. Use `send_message` or `request_task` for fix requests.

### DAG workflow: planner emits a dependency graph

The planner creates an entire task graph upfront using `depends_on` and `priority`:

1. **Planner creates tasks with dependencies**: Tasks with `depends_on` start as `blocked`. Tasks without dependencies start as `open`.
2. **Implementers claim open tasks**: They pick the highest-priority `open` task, skipping `blocked` ones.
3. **Auto-unblock**: When a task completes, the server checks if any `blocked` tasks had it as a dependency. If all deps are now `done`, the task transitions to `open`.
4. **Auto-cancel on failure**: If a task fails, all tasks that transitively depend on it are auto-cancelled.
5. **Planner handles cascades**: After a failure, the planner checks for cancelled tasks and decides: retry the failed task, skip the chain, or restructure.

This eliminates the need for the planner to manually sequence batches via polling.

### Termination protocol

When all planned work is complete:

1. Planner verifies no tasks are `open`, `claimed`, `in_progress`, `blocked`, or `approval_required`.
2. Planner broadcasts `[signal:complete]` with a summary.
3. Implementers recognize `[signal:complete]`, finish current work, and call `deregister`.
4. Planner summarizes results to the user and calls `deregister`.

### Two-session: planner reviews, implementer builds

Roles are conventions, not hard boundaries. A planner can also act as the reviewer, cutting the swarm to two sessions. This is useful for smaller tasks or when you want one session to own both the plan and the quality gate.

#### Setup

| Session | Label | Responsibilities |
|---------|-------|-----------------|
| Planner | `provider:codex-cli role:planner` | Plans work, creates tasks, reviews results |
| Implementer | `provider:codex-cli role:implementer` | Claims implementation tasks, sends back for review |

The planner does not need a `role:reviewer` label for this to work. Route review tasks to it by `assignee` instance ID.

If you prefer explicit discoverability, use a compound label like `role:planner role:reviewer` so other sessions can find it by either token.

#### Workflow

1. **Planner creates implementation work** -- same as the three-session pattern above.

2. **Implementer picks up the task** -- `claim_task` -> do the work -> `update_task` with `done` and a short result.

3. **Implementer requests review back to the planner:**

```json
{
  "type": "review",
  "title": "Review retry logic change",
  "description": "Check for retry loops and missing coverage.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"],
  "assignee": "<planner-instance-id>"
}
```

The `assignee` field is what makes this work. The implementer gets the planner's instance ID from `list_instances`.

4. **Planner reviews the work** -- claims the review task, inspects changes, reads annotations left by the implementer, then:
   - If approved: `update_task` with `done`
   - If changes needed: `update_task` with `failed` and a result describing what to fix, or `request_task` a new `fix` task assigned back to the implementer

5. **Cycle repeats** until the planner is satisfied.

#### AGENTS.md addition for this pattern

```md
## Swarm Roles

- The planner session also handles code review.
- Implementers should route `review` tasks back to the planner using `assignee`.
- The planner may respond with a `fix` task if the review finds issues.
```

## AGENTS.md Integration

Add role-aware rules to your `AGENTS.md` to make labels useful. For a complete ready-made version, copy [`docs/generic-AGENTS.md`](./generic-AGENTS.md). For role-specific additions, add:

```md
## Swarm Roles

- Read `role:` and `team:` tokens from swarm labels when choosing collaborators.
- Prefer a matching `team:` token when one exists for the task area.
- Fall back to any matching role, then to a generalist, when the ideal specialist is unavailable.
```

## Practical Limits

This model is intentionally lightweight. `swarm-mcp` does not enforce roles or auto-route tasks by role. Label parsing is only as reliable as your conventions, and different agents may follow the protocol better or worse depending on their instructions.

`swarm-mcp` is the coordination bus. Your instructions and orchestrators provide the team behavior.

---

**Note:** Orchestrators like Clanky already emit labels in this style (e.g. `origin:clanky provider:codex-cli role:implementer`). You can mix orchestrator-launched sessions with manually launched sessions that follow the same convention.
