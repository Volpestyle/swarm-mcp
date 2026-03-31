# Roles And Teams

`swarm-mcp` does not have first-class `role` or `team` fields.

Use label conventions instead.

## Recommended Role Tokens

- `role:planner`
- `role:implementer`
- `role:reviewer`
- `role:researcher`

Treat a session without `role:` as a generalist.

## Recommended Team Tokens

- `team:frontend`
- `team:api`
- `team:platform`

Use `scope` for hard separation and `team:` labels for soft grouping inside one swarm.

## Recommended Meanings

### Planner

- decomposes work
- creates tasks
- coordinates specialists
- keeps small plans or ownership notes in `kv_set`
- usually avoids being the primary editor

### Implementer

- claims implementation or fix work
- edits files
- uses locks and annotations carefully
- reports concrete results in `update_task`

### Reviewer

- inspects risks and correctness
- reviews touched files and annotations
- requests fixes or follow-up tasks when needed

### Researcher

- investigates code, docs, APIs, or runtime facts
- summarizes findings for planners or implementers

### Generalist

- handles overflow or mixed work
- fills gaps when no specialist is available

## Selection Heuristic

When choosing collaborators:

1. Prefer a same-team matching specialist if the swarm uses `team:` labels
2. Otherwise prefer any matching specialist by `role:`
3. Fall back to a generalist when no specialist is active

## Handoff Pattern

Use `request_task` for tracked work.

Implementation handoff example:

```json
{
  "type": "implement",
  "title": "Add retry logic to API client",
  "description": "Handle transient 429 and 503 responses in src/api/client.ts and update tests.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"]
}
```

Review handoff example:

```json
{
  "type": "review",
  "title": "Review retry logic change",
  "description": "Check for retry loops, incorrect status handling, and missing coverage.",
  "files": ["src/api/client.ts", "src/api/client.test.ts"]
}
```

Use `assignee` only when you know the target instance is active in the same scope.
