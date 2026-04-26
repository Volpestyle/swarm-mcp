# Investigation queries

Drop-in SQL for `~/.swarm-mcp/swarm.db`. Substitute `:scope` with the project scope (usually a git root path). All queries are read-only.

Recommended invocation:

```sh
SCOPE=/Users/you/path/to/project
sqlite3 -readonly -header -separator $'\t' ~/.swarm-mcp/swarm.db "<query>"
```

A label-resolution helper appears in many queries below as a left join, so UUIDs are translated to human labels (`role:planner provider:claude`) where possible. Live agents resolve via the `instances` table; deregistered ones resolve via their `instance.registered` event payload (24h window).

## Snapshot first

Before running any of these, run the CLI snapshot — it reads cleanly across all tables:

```sh
swarm-mcp inspect --scope "$SCOPE" --json
```

For more targeted snapshots: `swarm-mcp instances`, `tasks`, `messages`, `context`, `kv list` — all accept `--scope`.

## Timeline

The single most useful query — a chronological audit of everything in scope (last 24h):

```sql
SELECT
  datetime(e.created_at, 'unixepoch', 'localtime') AS ts,
  e.type,
  COALESCE(i.label, json_extract(reg.payload, '$.label'), e.actor) AS actor_label,
  e.subject,
  e.payload
FROM events e
LEFT JOIN instances i ON i.id = e.actor
LEFT JOIN events reg
  ON reg.actor = e.actor
 AND reg.type  = 'instance.registered'
 AND reg.scope = e.scope
WHERE e.scope = :scope
ORDER BY e.id ASC;
```

Time-windowed variant — last hour:

```sql
WHERE e.scope = :scope AND e.created_at >= unixepoch() - 3600
```

## Cast — who was online when

Live right now in scope:

```sql
SELECT id, label, pid, datetime(registered_at, 'unixepoch', 'localtime') AS joined,
       datetime(heartbeat, 'unixepoch', 'localtime') AS last_beat, adopted
FROM instances
WHERE scope = :scope
ORDER BY registered_at;
```

Everyone who appeared in scope in the last 24h, including pruned/deregistered:

```sql
SELECT
  e.actor AS instance_id,
  json_extract(e.payload, '$.label') AS label,
  datetime(MIN(e.created_at), 'unixepoch', 'localtime') AS first_seen,
  datetime(MAX(d.created_at), 'unixepoch', 'localtime') AS last_seen,
  GROUP_CONCAT(DISTINCT d.type)                         AS exit_types
FROM events e
LEFT JOIN events d
  ON d.scope = e.scope
 AND (
   (d.type = 'instance.deregistered' AND d.actor = e.actor)
   OR (d.type = 'instance.stale_reclaimed' AND d.subject = e.actor)
 )
WHERE e.scope = :scope AND e.type = 'instance.registered'
GROUP BY e.actor
ORDER BY first_seen;
```

## Task lifecycle

One task end-to-end:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, actor, subject, payload
FROM events
WHERE scope = :scope
  AND (subject = :task_id
       OR json_extract(payload, '$.task_id') = :task_id)
ORDER BY id;
```

Current state of one task (any age):

```sql
SELECT id, type, status, priority, title,
       requester, assignee, depends_on, parent_task_id,
       files, result,
       datetime(created_at, 'unixepoch', 'localtime') AS created,
       datetime(updated_at, 'unixepoch', 'localtime') AS updated
FROM tasks WHERE id = :task_id;
```

All active / blocked work in scope, with role labels:

```sql
SELECT t.status, t.priority, t.type, t.title,
       COALESCE(req.label, 'gone') AS requester,
       COALESCE(ass.label, '—')    AS assignee,
       t.depends_on
FROM tasks t
LEFT JOIN instances req ON req.id = t.requester
LEFT JOIN instances ass ON ass.id = t.assignee
WHERE t.scope = :scope AND t.status IN ('open', 'claimed', 'in_progress', 'blocked', 'approval_required')
ORDER BY t.priority DESC, t.created_at;
```

Dependency chain — what does this task block, what does it depend on:

```sql
-- depended on by (downstream):
SELECT id, status, title FROM tasks
WHERE scope = :scope AND depends_on LIKE '%' || :task_id || '%';

-- depends on (upstream): inspect the JSON array in tasks.depends_on for :task_id
SELECT depends_on FROM tasks WHERE id = :task_id;
```

Tasks that completed without ever being claimed (suspicious):

```sql
SELECT id, type, title, requester, result
FROM tasks
WHERE scope = :scope AND status = 'done' AND assignee IS NULL;
```

## Message threads

Direct conversation between two agents (peeks; does not flip `read`):

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       sender, recipient, read, content
FROM messages
WHERE scope = :scope
  AND ((sender = :a AND recipient = :b) OR (sender = :b AND recipient = :a))
ORDER BY id;
```

Inbox snapshot — unread counts per recipient:

```sql
SELECT COALESCE(i.label, m.recipient) AS recipient,
       COUNT(*) AS unread
FROM messages m
LEFT JOIN instances i ON i.id = m.recipient
WHERE m.scope = :scope AND m.read = 0 AND m.recipient IS NOT NULL
GROUP BY m.recipient
ORDER BY unread DESC;
```

System (`[auto]`) messages — task assignments, completions, recoveries:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       sender, recipient, content
FROM messages
WHERE scope = :scope AND content LIKE '[auto]%'
ORDER BY id DESC LIMIT 50;
```

Broadcast sends only (payload has recipient count and length, not content):

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       COALESCE(i.label, e.actor) AS sender,
       e.payload
FROM events e
LEFT JOIN instances i ON i.id = e.actor
WHERE e.scope = :scope AND e.type = 'message.broadcast'
ORDER BY e.id;
```

Broadcast message content is stored as one `messages` row per recipient, so there is no `recipient IS NULL` marker. To recover likely broadcast content, group duplicate sends:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       sender, content, COUNT(DISTINCT recipient) AS recipients
FROM messages
WHERE scope = :scope
GROUP BY sender, content, created_at
HAVING recipients > 1
ORDER BY MIN(id);
```

## File contention

Who is currently locking what:

```sql
SELECT c.file, COALESCE(i.label, c.instance_id) AS holder,
       c.content AS note,
       datetime(c.created_at, 'unixepoch', 'localtime') AS held_since
FROM context c
LEFT JOIN instances i ON i.id = c.instance_id
WHERE c.scope = :scope AND c.type = 'lock'
ORDER BY c.created_at;
```

Lock churn for one file (24h):

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, actor, payload
FROM events
WHERE scope = :scope AND subject = :file_path
  AND type IN ('context.lock_acquired', 'context.lock_released', 'context.annotated')
ORDER BY id;
```

Annotations on a file (any age):

```sql
SELECT datetime(c.created_at, 'unixepoch', 'localtime') AS ts,
       COALESCE(i.label, c.instance_id) AS author,
       c.content
FROM context c
LEFT JOIN instances i ON i.id = c.instance_id
WHERE c.scope = :scope AND c.file = :file_path AND c.type != 'lock'
ORDER BY c.created_at;
```

## KV history

Current value:

```sh
swarm-mcp kv get owner/planner --scope "$SCOPE"
```

All current keys in scope:

```sql
SELECT key, length(value) AS size,
       datetime(updated_at, 'unixepoch', 'localtime') AS updated
FROM kv WHERE scope = :scope ORDER BY key;
```

History of changes for one key (24h, value content not preserved — payload only stores length):

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, COALESCE(i.label, e.actor) AS actor, payload
FROM events e
LEFT JOIN instances i ON i.id = e.actor
WHERE e.scope = :scope AND e.subject = :key
  AND e.type IN ('kv.set', 'kv.deleted', 'kv.appended')
ORDER BY e.id;
```

Planner failovers — `owner/planner` flips:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, COALESCE(i.label, e.actor) AS actor
FROM events e
LEFT JOIN instances i ON i.id = e.actor
WHERE e.scope = :scope AND e.subject = 'owner/planner'
ORDER BY e.id;
```

## Stale agents

Pruned in last 24h (and why their successor took over):

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       subject AS reclaimed_instance,
       json_extract(payload, '$.label') AS label
FROM events
WHERE scope = :scope AND type = 'instance.stale_reclaimed'
ORDER BY id;
```

Instances that registered but never adopted (harness died before MCP came up):

```sql
SELECT id, label, pid, datetime(registered_at, 'unixepoch', 'localtime') AS joined
FROM instances
WHERE scope = :scope AND adopted = 0
ORDER BY registered_at;
```

## UI command queue

Pending UI commands — a long pending list means no `swarm-ui` is watching:

```sql
SELECT id, kind, status, created_by,
       datetime(created_at, 'unixepoch', 'localtime') AS queued,
       datetime(started_at, 'unixepoch', 'localtime') AS started,
       datetime(completed_at, 'unixepoch', 'localtime') AS finished,
       error
FROM ui_commands
WHERE scope = :scope
ORDER BY id DESC LIMIT 50;
```

## Common debugging recipes

**"Why is my task stuck blocked?"** — check its `depends_on` and the status of each dep:

```sql
WITH t AS (SELECT depends_on FROM tasks WHERE id = :task_id)
SELECT id, status, title FROM tasks
WHERE id IN (SELECT value FROM t, json_each(t.depends_on));
```

**"Who claimed and abandoned this task?"** — claim with no completion within N seconds:

```sql
SELECT t.id, t.title, t.status,
       COALESCE(i.label, t.assignee) AS assignee,
       datetime(t.updated_at, 'unixepoch', 'localtime') AS last_change
FROM tasks t
LEFT JOIN instances i ON i.id = t.assignee
WHERE t.scope = :scope
  AND t.status = 'claimed'
  AND t.updated_at < unixepoch() - 600;
```

**"Was a message ever delivered to its recipient?"** — `read = 1` means yes (consumed via `poll_messages`):

```sql
SELECT id, sender, recipient, read,
       datetime(created_at, 'unixepoch', 'localtime') AS sent_at,
       substr(content, 1, 80) AS snippet
FROM messages
WHERE scope = :scope AND id = :msg_id;
```

**"Reconstruct the full session for one agent"**:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime') AS ts,
       type, subject, payload
FROM events
WHERE scope = :scope AND actor = :instance_id
ORDER BY id;
```
