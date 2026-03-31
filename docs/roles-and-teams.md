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

- break work into steps
- create or assign tasks
- keep shared plans in `kv_set`
- coordinate implementers and reviewers
- avoid editing code unless the task clearly requires it

### Implementer

Use `role:implementer` for sessions that should:

- claim implementation or fix tasks
- lock files before editing
- annotate important findings on touched files
- update tasks with concrete results when finished

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

Use this when everyone should stay in one shared swarm but still advertise specialties or sub-groups.

Because `team:` is only a convention, your instructions should say how to use it. For example:

- prefer collaborators with matching `team:` tokens when the task is local to that area
- fall back to any matching `role:` if no same-team specialist is active
- fall back to generalists if no specialist is active at all

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
  "files": ["src/api/client.ts", "src/api/client.test.ts"]
}
```

Set `assignee` to a known instance ID for direct assignment, or omit it for any implementer to claim.

#### 4. Implementer picks up the task

`claim_task` -> `update_task` to `in_progress` -> `check_file` -> `lock_file` -> do the work -> `annotate` findings -> `unlock_file` -> `update_task` with `done` and a short result.

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

Inspect the task, `check_file` for annotations, add `annotate` notes for risks or follow-ups, then `update_task` with `done`, `failed`, or `cancelled`. Use `send_message` or `request_task` for fix requests.

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
