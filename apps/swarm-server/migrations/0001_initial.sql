CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  client_device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS devices_client_device_active_idx
  ON devices(client_device_id, revoked_at, last_seen_at, created_at);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  session_id TEXT UNIQUE,
  cert_fingerprint TEXT NOT NULL,
  pairing_secret TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  canceled_at INTEGER,
  expired_at INTEGER
);

CREATE TABLE IF NOT EXISTS rate_limits (
  token_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, bucket, window_start)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_device_id TEXT,
  kind TEXT NOT NULL,
  subject TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);
