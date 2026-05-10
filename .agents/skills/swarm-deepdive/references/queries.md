# Investigation Queries

Drop-in SQL for `${SWARM_DB_PATH:-~/.swarm-mcp/swarm.db}`. Substitute or bind `:scope`, `:task_id`, `:instance_id`, `:key`, and other parameters before running.

Recommended interactive setup:

```sh
DB=${SWARM_DB_PATH:-$HOME/.swarm-mcp/swarm.db}
sqlite3 -readonly -header -separator $'\t' "$DB"
```

Then in sqlite:

```sql
.parameter init
.parameter set :scope '/Users/you/path/to/project'
.parameter set :task_id 'task-uuid-if-needed'
.parameter set :instance_id 'instance-uuid-if-needed'
.parameter set :key 'owner/planner'
```

For strict forensics, run read-only SQL before `swarm-mcp inspect`. The CLI is useful, but it runs stale pruning before read commands.

## Snapshot Or Evidence First

Live snapshot after accepting normal prune side effects:

```sh
swarm-mcp inspect --scope "$SCOPE" --json
```

Data freshness and retention check:

```sql
SELECT 'events' AS source,
       COUNT(*) AS rows,
       datetime(MIN(created_at), 'unixepoch', 'localtime') AS oldest,
       datetime(MAX(created_at), 'unixepoch', 'localtime') AS newest
FROM events WHERE scope = :scope
UNION ALL
SELECT 'messages', COUNT(*),
       datetime(MIN(created_at), 'unixepoch', 'localtime'),
       datetime(MAX(created_at), 'unixepoch', 'localtime')
FROM messages WHERE scope = :scope
UNION ALL
SELECT 'terminal_tasks', COUNT(*),
       datetime(MIN(updated_at), 'unixepoch', 'localtime'),
       datetime(MAX(updated_at), 'unixepoch', 'localtime')
FROM tasks WHERE scope = :scope AND status IN ('done', 'failed', 'cancelled');
```

## Timeline

Chronological audit log for one scope:

```sql
WITH latest_reg AS (
  SELECT scope, actor, MAX(id) AS event_id
  FROM events
  WHERE type = 'instance.registered'
  GROUP BY scope, actor
), labels AS (
  SELECT e.scope, e.actor, json_extract(e.payload, '$.label') AS label
  FROM events e
  JOIN latest_reg r ON r.scope = e.scope AND r.actor = e.actor AND r.event_id = e.id
)
SELECT
  e.id,
  datetime(e.created_at, 'unixepoch', 'localtime') AS ts,
  e.type,
  COALESCE(i.label, labels.label, e.actor, 'null') AS actor_label,
  e.subject,
  e.payload
FROM events e
LEFT JOIN instances i ON i.id = e.actor
LEFT JOIN labels ON labels.scope = e.scope AND labels.actor = e.actor
WHERE e.scope = :scope
ORDER BY e.id ASC;
```

Time-windowed variant, last hour:

```sql
WHERE e.scope = :scope AND e.created_at >= unixepoch() - 3600
```

Event type counts for a quick shape of the incident:

```sql
SELECT type, COUNT(*) AS count,
       datetime(MIN(created_at), 'unixepoch', 'localtime') AS first_seen,
       datetime(MAX(created_at), 'unixepoch', 'localtime') AS last_seen
FROM events
WHERE scope = :scope
GROUP BY type
ORDER BY count DESC, type;
```

## Cast

Live agents in scope:

```sql
SELECT id, label, pid, adopted,
       datetime(registered_at, 'unixepoch', 'localtime') AS joined,
       datetime(heartbeat, 'unixepoch', 'localtime') AS last_beat,
       unixepoch() - heartbeat AS idle_seconds
FROM instances
WHERE scope = :scope
ORDER BY registered_at, id;
```

Everyone who appeared in the event window, including deregistered or stale agents:

```sql
SELECT
  reg.actor AS instance_id,
  json_extract(reg.payload, '$.label') AS label,
  datetime(reg.created_at, 'unixepoch', 'localtime') AS registered_at,
  datetime(ex.created_at, 'unixepoch', 'localtime') AS exited_at,
  ex.type AS exit_type,
  ex.payload AS exit_payload
FROM events reg
LEFT JOIN events ex
  ON ex.scope = reg.scope
 AND (
   (ex.type = 'instance.deregistered' AND ex.subject = reg.actor)
   OR (ex.type = 'instance.stale_reclaimed' AND ex.subject = reg.actor)
 )
WHERE reg.scope = :scope AND reg.type = 'instance.registered'
ORDER BY reg.id;
```

## Task Lifecycle

One task end-to-end:

```sql
SELECT e.id,
       datetime(e.created_at, 'unixepoch', 'localtime') AS ts,
       e.type,
       COALESCE(i.label, e.actor) AS actor,
       e.subject,
       e.payload
FROM events e
LEFT JOIN instances i ON i.id = e.actor
WHERE e.scope = :scope
  AND (e.subject = :task_id OR json_extract(e.payload, '$.task_id') = :task_id)
ORDER BY e.id;
```

Current state of one task:

```sql
SELECT id, type, status, priority, title,
       requester, assignee, depends_on, parent_task_id,
       idempotency_key, files, result,
       datetime(created_at, 'unixepoch', 'localtime') AS created,
       datetime(updated_at, 'unixepoch', 'localtime') AS updated,
       datetime(changed_at / 1000, 'unixepoch', 'localtime') AS changed
FROM tasks
WHERE scope = :scope AND id = :task_id;
```

Active, blocked, and approval-gated work:

```sql
SELECT t.id, t.status, t.priority, t.type, t.title,
       COALESCE(req.label, t.requester) AS requester,
       COALESCE(ass.label, t.assignee, '-') AS assignee,
       t.depends_on
FROM tasks t
LEFT JOIN instances req ON req.id = t.requester
LEFT JOIN instances ass ON ass.id = t.assignee
WHERE t.scope = :scope
  AND t.status IN ('open', 'claimed', 'in_progress', 'blocked', 'approval_required')
ORDER BY t.priority DESC, t.created_at, t.id;
```

Dependencies for one task:

```sql
SELECT dep.value AS dependency_id,
       d.status,
       d.title
FROM tasks t,
     json_each(COALESCE(t.depends_on, '[]')) AS dep
LEFT JOIN tasks d ON d.scope = t.scope AND d.id = dep.value
WHERE t.scope = :scope AND t.id = :task_id;
```

Tasks blocked by one task:

```sql
SELECT t.id, t.status, t.title
FROM tasks t,
     json_each(COALESCE(t.depends_on, '[]')) AS dep
WHERE t.scope = :scope AND dep.value = :task_id
ORDER BY t.created_at;
```

## Messages

Recent message rows between two agents. This table is short-lived and may only cover about one hour:

```sql
SELECT id,
       datetime(created_at, 'unixepoch', 'localtime') AS ts,
       sender, recipient, read, content
FROM messages
WHERE scope = :scope
  AND ((sender = :a AND recipient = :b) OR (sender = :b AND recipient = :a))
ORDER BY id;
```

Event-backed message history in the 24-hour event window:

```sql
SELECT e.id,
       datetime(e.created_at, 'unixepoch', 'localtime') AS ts,
       e.type,
       COALESCE(i.label, e.actor) AS sender,
       e.subject AS recipient_or_null,
       json_extract(e.payload, '$.recipients') AS broadcast_recipients,
       json_extract(e.payload, '$.content') AS content
FROM events e
LEFT JOIN instances i ON i.id = e.actor
WHERE e.scope = :scope
  AND e.type IN ('message.sent', 'message.broadcast')
ORDER BY e.id;
```

Unread inbox counts per live recipient:

```sql
SELECT COALESCE(i.label, m.recipient) AS recipient,
       COUNT(*) AS unread
FROM messages m
LEFT JOIN instances i ON i.id = m.recipient
WHERE m.scope = :scope AND m.read = 0 AND m.recipient IS NOT NULL
GROUP BY m.recipient
ORDER BY unread DESC;
```

History-clearing actions from `swarm-ui`:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       actor, subject, payload
FROM events
WHERE scope = :scope AND type = 'message.cleared'
ORDER BY id;
```

## File Contention

Current locks:

```sql
SELECT c.file,
       COALESCE(i.label, c.instance_id) AS holder,
       c.content AS note,
       datetime(c.created_at, 'unixepoch', 'localtime') AS held_since
FROM context c
LEFT JOIN instances i ON i.id = c.instance_id
WHERE c.scope = :scope AND c.type = 'lock'
ORDER BY c.created_at;
```

Lock and annotation churn for one file inside the event window:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, actor, payload
FROM events
WHERE scope = :scope
  AND subject = :file_path
  AND type IN ('context.lock_acquired', 'context.lock_released', 'context.annotated')
ORDER BY id;
```

Current annotations for one file. Non-lock annotations are cleanup-pruned after 24 hours:

```sql
SELECT datetime(c.created_at, 'unixepoch', 'localtime') AS ts,
       COALESCE(i.label, c.instance_id) AS author,
       c.type,
       c.content
FROM context c
LEFT JOIN instances i ON i.id = c.instance_id
WHERE c.scope = :scope AND c.file = :file_path AND c.type != 'lock'
ORDER BY c.created_at;
```

## KV History

Current value:

```sql
SELECT key, value, datetime(updated_at, 'unixepoch', 'localtime') AS updated
FROM kv
WHERE scope = :scope AND key = :key;
```

All current keys in scope:

```sql
SELECT key, length(value) AS size,
       datetime(updated_at, 'unixepoch', 'localtime') AS updated
FROM kv
WHERE scope = :scope
ORDER BY key;
```

History of MCP-side changes for one key. Values may be sensitive:

```sql
SELECT e.id,
       datetime(e.created_at, 'unixepoch', 'localtime') AS ts,
       e.type,
       COALESCE(i.label, e.actor) AS actor,
       json_extract(e.payload, '$.value') AS set_value,
       json_extract(e.payload, '$.prior_value') AS deleted_prior_value,
       json_extract(e.payload, '$.appended') AS appended_value,
       e.payload
FROM events e
LEFT JOIN instances i ON i.id = e.actor
WHERE e.scope = :scope
  AND e.subject = :key
  AND e.type IN ('kv.set', 'kv.deleted', 'kv.appended')
ORDER BY e.id;
```

Planner owner current value and event history:

```sql
SELECT value, datetime(updated_at, 'unixepoch', 'localtime') AS updated
FROM kv
WHERE scope = :scope AND key = 'owner/planner';

SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, actor, payload
FROM events
WHERE scope = :scope AND subject = 'owner/planner'
ORDER BY id;
```

## Stale Agents

Pruned or reclaimed instances in the event window:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       subject AS reclaimed_instance,
       json_extract(payload, '$.label') AS label,
       payload
FROM events
WHERE scope = :scope AND type = 'instance.stale_reclaimed'
ORDER BY id;
```

UI-spawned rows that have not adopted yet:

```sql
SELECT id, label, pid,
       datetime(registered_at, 'unixepoch', 'localtime') AS joined,
       datetime(heartbeat, 'unixepoch', 'localtime') AS last_beat,
       unixepoch() - heartbeat AS idle_seconds
FROM instances
WHERE scope = :scope AND adopted = 0
ORDER BY registered_at;
```

Tasks released by stale reclaim or deregister are visible as task status/assignee changes plus `instance.stale_reclaimed` or `instance.deregistered` events. Messages for the removed recipient are deleted during release.

## UI Command Queue

Pending or recent UI commands:

```sql
SELECT id, kind, status, created_by, claimed_by,
       datetime(created_at, 'unixepoch', 'localtime') AS queued,
       datetime(started_at, 'unixepoch', 'localtime') AS started,
       datetime(completed_at, 'unixepoch', 'localtime') AS finished,
       result, error
FROM ui_commands
WHERE scope = :scope
ORDER BY id DESC
LIMIT 50;
```

Event history for one UI command:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, actor, subject, payload
FROM events
WHERE scope = :scope
  AND type LIKE 'ui.command.%'
  AND json_extract(payload, '$.command_id') = :command_id
ORDER BY id;
```

If commands stay `pending`, no `swarm-ui` worker is claiming rows for this DB. Check `server-logs.md` and confirm the desktop app is connected to the same `SWARM_DB_PATH`.

## Common Debugging Recipes

Why is a task blocked?

```sql
SELECT t.id AS blocked_task,
       dep.value AS dependency_id,
       d.status AS dependency_status,
       d.title AS dependency_title
FROM tasks t,
     json_each(COALESCE(t.depends_on, '[]')) AS dep
LEFT JOIN tasks d ON d.scope = t.scope AND d.id = dep.value
WHERE t.scope = :scope AND t.id = :task_id;
```

Who claimed work and then stopped updating it?

```sql
SELECT t.id, t.title, t.status,
       COALESCE(i.label, t.assignee) AS assignee,
       datetime(t.updated_at, 'unixepoch', 'localtime') AS last_change,
       unixepoch() - t.updated_at AS idle_seconds
FROM tasks t
LEFT JOIN instances i ON i.id = t.assignee
WHERE t.scope = :scope
  AND t.status IN ('claimed', 'in_progress')
  AND t.updated_at < unixepoch() - 600
ORDER BY t.updated_at;
```

Was a message consumed by its recipient?

```sql
SELECT id, sender, recipient, read,
       datetime(created_at, 'unixepoch', 'localtime') AS sent_at,
       substr(content, 1, 120) AS snippet
FROM messages
WHERE scope = :scope AND id = :msg_id;
```

Reconstruct all events caused by one agent:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, subject, payload
FROM events
WHERE scope = :scope AND actor = :instance_id
ORDER BY id;
```

Find events where one agent was the subject, even if `system` was the actor:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, actor, payload
FROM events
WHERE scope = :scope AND subject = :instance_id
ORDER BY id;
```
