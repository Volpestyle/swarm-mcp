INSERT INTO kv_scope_updates (scope, changed_at)
SELECT scope, MAX(updated_at) * 1000
FROM kv
GROUP BY scope
ON CONFLICT(scope) DO NOTHING;

UPDATE instances SET scope = directory WHERE scope = '';
UPDATE instances SET root = directory WHERE root = '';
UPDATE instances SET file_root = directory WHERE file_root = '';
UPDATE tasks SET changed_at = updated_at * 1000 WHERE changed_at = 0;

CREATE INDEX IF NOT EXISTS messages_scope_recipient_read_idx
  ON messages(scope, recipient, read, id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx
  ON messages(created_at);
CREATE INDEX IF NOT EXISTS instances_scope_idx
  ON instances(scope);
CREATE INDEX IF NOT EXISTS instances_heartbeat_idx
  ON instances(heartbeat);
CREATE INDEX IF NOT EXISTS tasks_scope_status_idx
  ON tasks(scope, status);
CREATE INDEX IF NOT EXISTS tasks_scope_assignee_idx
  ON tasks(scope, assignee);
CREATE INDEX IF NOT EXISTS tasks_scope_changed_at_idx
  ON tasks(scope, changed_at);
CREATE INDEX IF NOT EXISTS context_scope_file_idx
  ON context(scope, file);
CREATE INDEX IF NOT EXISTS context_task_lock_idx
  ON context(scope, instance_id, task_id) WHERE type = 'lock' AND task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS context_lock_idx
  ON context(scope, file) WHERE type = 'lock';
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key_idx
  ON tasks(scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_scope_id_idx
  ON events(scope, id);
CREATE INDEX IF NOT EXISTS events_created_at_idx
  ON events(created_at);
CREATE INDEX IF NOT EXISTS ui_commands_scope_status_id_idx
  ON ui_commands(scope, status, id);
