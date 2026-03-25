import { db } from "./db"
import { randomUUIDv7 } from "bun"

const STALE_SECONDS = 30
const MESSAGE_TTL_SECONDS = 3600

export function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_SECONDS
  db.run("DELETE FROM instances WHERE heartbeat < ?", [cutoff])
  const msgCutoff = Math.floor(Date.now() / 1000) - MESSAGE_TTL_SECONDS
  db.run("DELETE FROM messages WHERE created_at < ?", [msgCutoff])
}

export function register(directory: string, label?: string) {
  prune()
  const id = randomUUIDv7()
  const pid = process.pid
  db.run("INSERT INTO instances (id, directory, pid, label) VALUES (?, ?, ?, ?)", [id, directory, pid, label ?? null])
  return id
}

export function deregister(id: string) {
  db.run("DELETE FROM instances WHERE id = ?", [id])
  db.run("DELETE FROM messages WHERE sender = ? OR recipient = ?", [id, id])
}

export function heartbeat(id: string) {
  const now = Math.floor(Date.now() / 1000)
  db.run("UPDATE instances SET heartbeat = ? WHERE id = ?", [now, id])
  prune()
}

export function list() {
  prune()
  return db.query("SELECT id, directory, pid, label, registered_at, heartbeat FROM instances").all()
}
