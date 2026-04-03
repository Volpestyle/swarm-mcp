# Design: `request_task_batch`

Item #6 from the improvement list. This spec defines the API shape, reference semantics, error handling, and transaction behavior for atomic batch task creation.

## Problem

A planner creating 8 tasks with inter-dependencies via 8 separate `request_task` calls has two issues:

1. **Race condition**: Agents can claim early tasks before the full DAG is emitted.
2. **No atomic rollback**: If task 5 fails validation, tasks 1-4 already exist as orphans.

## API Shape

### Tool: `request_task_batch`

**Parameters:**

```typescript
{
  tasks: Array<{
    type: "review" | "implement" | "fix" | "test" | "research" | "other";
    title: string;
    description?: string;
    files?: string[];
    assignee?: string;          // instance ID
    priority?: number;          // integer, default 0
    depends_on?: string[];      // mix of $N refs and external task IDs
    idempotency_key?: string;   // optional, prevents duplicate creation
    parent_task_id?: string;    // optional, can be $N ref or external task ID
    approval_required?: boolean; // optional, requires approve_task before work begins
  }>
}
```

**Returns:**

```json
{
  "task_ids": ["uuid-1", "uuid-2", "uuid-3"],
  "created": 2,
  "existing": 1,
  "tasks": [
    { "id": "uuid-1", "status": "blocked", "idempotency_key": "plan-v1/task-1", "new": true },
    { "id": "uuid-2", "status": "open",    "idempotency_key": "plan-v1/task-2", "new": true },
    { "id": "uuid-3", "status": "claimed",  "idempotency_key": "plan-v1/task-3", "new": false }
  ]
}
```

## `$N` Reference Semantics

`$N` is a 1-indexed positional reference to another task in the same batch.

- `$1` refers to the 1st task in the array (index 0).
- `$2` refers to the 2nd task, etc.
- `$N` can appear in `depends_on` and `parent_task_id`.

### Rules

1. **No forward references**: `$N` where N >= the current task's position is invalid. Task 2 can reference `$1` but not `$2` or `$3`. This prevents circular dependencies within the batch.
2. **Mixed references**: `depends_on` can contain both `$N` refs and external task UUIDs. Example: `depends_on: ["$1", "abc-123-existing-task"]`.
3. **Resolution**: After all tasks are inserted, `$N` refs in the stored `depends_on` JSON are replaced with actual UUIDs.

### Example

```json
{
  "tasks": [
    {
      "type": "implement",
      "title": "Add auth middleware",
      "priority": 10,
      "idempotency_key": "auth-plan/middleware"
    },
    {
      "type": "implement",
      "title": "Add auth routes",
      "priority": 10,
      "idempotency_key": "auth-plan/routes"
    },
    {
      "type": "test",
      "title": "Integration tests for auth",
      "priority": 5,
      "depends_on": ["$1", "$2"],
      "idempotency_key": "auth-plan/tests"
    },
    {
      "type": "review",
      "title": "Review entire auth feature",
      "priority": 1,
      "depends_on": ["$3"],
      "assignee": "<planner-id>",
      "idempotency_key": "auth-plan/review"
    }
  ]
}
```

This creates a diamond DAG:
```
middleware ($1) ──┐
                  ├──> tests ($3) ──> review ($4)
routes ($2)    ──┘
```

Tasks 1 and 2 start as `open` (no deps). Task 3 starts as `blocked` (waiting on 1 and 2). Task 4 starts as `blocked` (waiting on 3).

## Status Resolution

Each task's initial status is determined in this order:

| Condition | Initial Status |
|-----------|---------------|
| Any dependency is already `failed` or `cancelled` | `cancelled` |
| `approval_required: true` and no dependency has already failed/cancelled | `approval_required` |
| No `depends_on` + no `assignee` | `open` |
| No `depends_on` + has `assignee` | `claimed` |
| All deps are already `done` + no `assignee` | `open` |
| All deps are already `done` + has `assignee` | `claimed` |
| Any dep is not `done` (including `$N` refs) | `blocked` |

Notes:
- `$N` refs always point to tasks in the same batch, which are never `done` at creation time. So any non-approval task with a `$N` ref in `depends_on` will start as `blocked`.
- Approval-gated tasks stay `approval_required` until `approve_task` is called. Approval re-evaluates dependencies and transitions the task to `open`, `claimed`, `blocked`, or `cancelled`.

## Idempotency Handling

When a task has an `idempotency_key`:

1. Check if a task with that key already exists in the scope.
2. If it exists: **skip creation**, use the existing task's ID for `$N` resolution.
3. If it doesn't exist: create normally.

This means:
- A planner can safely retry a batch after a crash. Already-created tasks are reused; new tasks are created.
- `$N` refs resolve correctly whether the referenced task is new or reused.
- The `existing` count in the return value tells the planner how many were deduplicated.

### Edge case: duplicate key reused within the same batch

If the same `idempotency_key` appears on two new entries in one batch, validation fails. This avoids ambiguous `$N` resolution and SQLite unique-key failures.

### Edge case: existing task has different parameters

If a task with the same `idempotency_key` exists but has different `title`, `type`, etc., the server does **not** update it. It returns the existing task as-is. The `idempotency_key` guarantees "at most once creation," not "upsert."

This is intentional. If the planner wants to modify an existing task, it should use `update_task`.

## Transaction Semantics

The entire batch is wrapped in a single SQLite transaction.

### Validation (before any inserts)

1. Validate all duplicate `idempotency_key` values within the batch: a new key may appear at most once.
2. Validate all `assignee` values: each must be an active instance in the same scope (unless the task will be deduplicated via idempotency_key).
3. Validate all `$N` references: N must be >= 1 and < the current task's position.
4. Validate all external task IDs in `depends_on`: each must exist in the same scope (unless the task will be deduplicated).
5. Validate all `parent_task_id` values: must be a valid `$N` ref or existing task ID.

### On validation failure

Entire batch rolls back. No tasks are created. Return an error indicating which task (by position) and which field failed validation.

```json
{
  "error": "Validation failed",
  "details": [
    { "task_index": 2, "field": "depends_on", "message": "$5 is out of range (batch has 4 tasks)" }
  ]
}
```

### On success

All tasks are inserted atomically. Auto-notification messages are sent for newly created tasks with `assignee`.

## Auto-Notifications

For each newly created task in the batch that has an `assignee`:
- Send an `[auto]` message to the assignee (same format as `request_task`)
- Group multiple tasks for the same assignee into a single notification if practical

## Implementation Notes

### Suggested pseudocode

```
function requestTaskBatch(requester, scope, taskSpecs):
  // Phase 1: Resolve idempotency keys
  resolvedIds = []
  for each spec in taskSpecs:
    if spec.idempotency_key:
      existing = findByIdempotencyKey(scope, spec.idempotency_key)
      if existing:
        resolvedIds.push({ id: existing.id, new: false })
        continue
    resolvedIds.push({ id: randomUUID(), new: true })

  // Phase 2: Resolve $N references
  for each spec at index i:
    if spec.depends_on:
      spec.depends_on = spec.depends_on.map(ref =>
        ref.startsWith("$") ? resolvedIds[parseInt(ref.slice(1)) - 1].id : ref
      )
    if spec.parent_task_id?.startsWith("$"):
      spec.parent_task_id = resolvedIds[parseInt(spec.parent_task_id.slice(1)) - 1].id

  // Phase 3: Validate
  validate(taskSpecs, resolvedIds, scope)  // throws on failure

  // Phase 4: Insert in transaction
  transaction:
    for each spec at index i:
      if resolvedIds[i].new:
        insertTask(resolvedIds[i].id, spec, requester, scope)

  // Phase 5: Send notifications
  for each spec at index i:
    if resolvedIds[i].new && spec.assignee:
      sendAutoNotification(requester, scope, spec.assignee, spec, resolvedIds[i].id)

  return { task_ids: resolvedIds.map(r => r.id), ... }
```

### Dependency on other items

- Requires `depends_on` field on tasks (item #2)
- Requires `idempotency_key` field on tasks (item #3)
- Requires `priority` field on tasks (item #1)
- Optionally uses `parent_task_id` (item #9)
- All of these must land before batch creation can be implemented

### Size limits

Consider a reasonable upper bound on batch size to prevent abuse or accidental huge transactions. Suggested: max 50 tasks per batch.
