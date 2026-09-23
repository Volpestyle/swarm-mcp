// Run with Bun. Optional argument points at a baseline checkout, never a database.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const fixture = mkdtempSync(join(tmpdir(), "swarm-baseline-loss-"));
process.env.SWARM_DB_PATH = join(fixture, "swarm.db");
const moduleAt = (name: string) => import(pathToFileURL(join(root, "src", `${name}.ts`)).href);
const { db } = await moduleAt("db");
const registry = await moduleAt("registry");
const messages = await moduleAt("messages");
const scope = "baseline-loss-fixture";
const sender = registry.register(fixture, "identity:baseline sender", scope);
const recipient = registry.register(fixture, "identity:baseline recipient", scope);
const count = () => db.query("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?").get(recipient.id).n;

messages.send(sender.id, scope, recipient.id, "lost-response");
const fetched = messages.poll(recipient.id, scope).length;
const retry = messages.poll(recipient.id, scope).length;
assert.equal(fetched, 1);
assert.equal(retry, 0);
db.run("DELETE FROM messages");

messages.send(sender.id, scope, recipient.id, "expired-unread");
db.run("UPDATE messages SET created_at = unixepoch() - 3601");
const expiryBefore = count();
registry.prune();
const expiryAfter = count();
assert.equal(expiryBefore, 1);
assert.equal(expiryAfter, 0);

messages.send(sender.id, scope, recipient.id, "stale-unread");
db.run("UPDATE instances SET heartbeat = 0 WHERE id = ?", [recipient.id]);
const staleBefore = count();
registry.prune();
const staleAfter = count();
assert.equal(staleBefore, 1);
assert.equal(staleAfter, 0);
console.log(JSON.stringify({ root, fixture,
  schema: db.query("PRAGMA user_version").get(),
  lostResponse: { fetched, retry },
  unreadExpiry: { before: expiryBefore, after: expiryAfter },
  staleRecipient: { before: staleBefore, after: staleAfter },
}, null, 2));
