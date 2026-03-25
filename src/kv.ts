import { db } from "./db"

export function get(key: string) {
  const row = db.query("SELECT value, updated_at FROM kv WHERE key = ?").get(key) as {
    value: string
    updated_at: number
  } | null
  return row
}

export function set(key: string, value: string) {
  db.run(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  )
}

export function del(key: string) {
  db.run("DELETE FROM kv WHERE key = ?", [key])
}

export function keys(prefix?: string) {
  if (prefix) {
    return db.query("SELECT key, updated_at FROM kv WHERE key LIKE ? ORDER BY key").all(prefix + "%")
  }
  return db.query("SELECT key, updated_at FROM kv ORDER BY key").all()
}
