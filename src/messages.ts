import { db } from "./db";
import { list, prune } from "./registry";

function marks(size: number) {
  return Array.from({ length: size }, () => "?").join(",");
}

export function send(
  sender: string,
  scope: string,
  recipient: string,
  content: string,
) {
  prune();
  db.run(
    "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
    [scope, sender, recipient, content],
  );
}

export function broadcast(sender: string, scope: string, content: string) {
  prune();

  const rows = (list(scope) as Array<{ id: string }>).filter(
    (item) => item.id !== sender,
  );
  if (!rows.length) return 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      db.run(
        "INSERT INTO messages (scope, sender, recipient, content) VALUES (?, ?, ?, ?)",
        [scope, sender, row.id, content],
      );
    }
  });
  tx();
  return rows.length;
}

export function poll(recipient: string, scope: string, limit = 50) {
  prune();

  const rows = db
    .query(
      `SELECT id, sender, content, created_at
       FROM messages
       WHERE scope = ? AND recipient = ? AND read = 0
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(scope, recipient, limit) as Array<{
    id: number;
    sender: string;
    content: string;
    created_at: number;
  }>;

  if (rows.length) {
    db.run(
      `UPDATE messages SET read = 1 WHERE id IN (${marks(rows.length)})`,
      rows.map((row) => row.id),
    );
  }

  return rows;
}

export function peek(recipient: string, scope: string, limit = 50) {
  return db
    .query(
      `SELECT id, sender, content, created_at
       FROM messages
       WHERE scope = ? AND recipient = ? AND read = 0
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(scope, recipient, limit);
}
