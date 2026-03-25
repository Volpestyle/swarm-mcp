import { db } from "./db";
import { prune } from "./registry";

export function send(sender: string, recipient: string, content: string) {
  prune();
  db.run("INSERT INTO messages (sender, recipient, content) VALUES (?, ?, ?)", [
    sender,
    recipient,
    content,
  ]);
}

export function broadcast(sender: string, content: string) {
  prune();
  db.run(
    "INSERT INTO messages (sender, recipient, content) VALUES (?, NULL, ?)",
    [sender, content],
  );
}

export function poll(recipient: string, limit = 50) {
  prune();
  const rows = db
    .query(
      `SELECT id, sender, content, created_at
       FROM messages
       WHERE (recipient = ? OR recipient IS NULL) AND read = 0 AND sender != ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(recipient, recipient, limit);

  if (rows.length > 0) {
    const ids = (rows as Array<{ id: number }>).map((r) => r.id);
    db.run(
      `UPDATE messages SET read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
  }

  return rows;
}

export function peek(recipient: string, limit = 50) {
  return db
    .query(
      `SELECT id, sender, content, created_at
       FROM messages
       WHERE (recipient = ? OR recipient IS NULL) AND read = 0 AND sender != ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(recipient, recipient, limit);
}
