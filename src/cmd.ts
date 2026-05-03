import { db } from "./db";
import * as context from "./context";
import * as kv from "./kv";
import * as messages from "./messages";
import * as registry from "./registry";
import * as ui from "./ui";
import { scope as scopeFor } from "./paths";

type Flags = {
  positional: string[];
  json: boolean;
  scope?: string;
  as?: string;
  to?: string;
  from?: string;
  limit?: number;
  prefix?: string;
  status?: string;
  note?: string;
  target?: string;
  harness?: string;
  role?: string;
  label?: string;
  kind?: string;
  surface?: string;
  x?: number;
  y?: number;
  out?: string;
  wait?: number;
  enter: boolean;
};

type InstRow = {
  id: string;
  scope: string;
  directory: string;
  label: string | null;
  pid: number;
  registered_at: number;
  heartbeat: number;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], json: false, enter: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { flags.json = true; continue; }
    if (a === "--scope") { flags.scope = argv[++i]; continue; }
    if (a === "--as") { flags.as = argv[++i]; continue; }
    if (a === "--to") { flags.to = argv[++i]; continue; }
    if (a === "--from") { flags.from = argv[++i]; continue; }
    if (a === "--limit") { flags.limit = parseInt(argv[++i] ?? "", 10); continue; }
    if (a === "--prefix") { flags.prefix = argv[++i]; continue; }
    if (a === "--status") { flags.status = argv[++i]; continue; }
    if (a === "--note") { flags.note = argv[++i]; continue; }
    if (a === "--target") { flags.target = argv[++i]; continue; }
    if (a === "--harness") { flags.harness = argv[++i]; continue; }
    if (a === "--role") { flags.role = argv[++i]; continue; }
    if (a === "--label") { flags.label = argv[++i]; continue; }
    if (a === "--kind") { flags.kind = argv[++i]; continue; }
    if (a === "--surface") { flags.surface = argv[++i]; continue; }
    if (a === "--x") { flags.x = parseFloat(argv[++i] ?? ""); continue; }
    if (a === "--y") { flags.y = parseFloat(argv[++i] ?? ""); continue; }
    if (a === "--out") { flags.out = argv[++i]; continue; }
    if (a === "--wait") { flags.wait = parseFloat(argv[++i] ?? ""); continue; }
    if (a === "--no-enter") { flags.enter = false; continue; }
    if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    flags.positional.push(a);
  }
  return flags;
}

function resolveScope(flags: Flags): string {
  return scopeFor(process.cwd(), flags.scope);
}

function instancesInScope(scope: string): InstRow[] {
  return db.query(
    "SELECT id, scope, directory, label, pid, registered_at, heartbeat FROM instances WHERE scope = ? ORDER BY registered_at ASC",
  ).all(scope) as InstRow[];
}

function formatInst(i: { id: string; label: string | null }) {
  const short = i.id.slice(0, 8);
  return i.label ? `${short} (${i.label})` : short;
}

function resolveInstanceRef(ref: string, insts: InstRow[]): string {
  const byId = insts.find((i) => i.id === ref);
  if (byId) return byId.id;
  const byPrefix = insts.filter((i) => i.id.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0].id;
  if (byPrefix.length > 1) {
    throw new Error(
      `Ambiguous id prefix "${ref}": ${byPrefix.map(formatInst).join(", ")}`,
    );
  }
  const byLabel = insts.filter((i) => i.label?.includes(ref));
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1) {
    throw new Error(
      `Ambiguous label match "${ref}": ${byLabel.map(formatInst).join(", ")}`,
    );
  }
  throw new Error(
    `No instance matches "${ref}" in this scope. Candidates: ${insts.map(formatInst).join(", ") || "(none)"}`,
  );
}

function resolveIdentity(scope: string, flags: Flags): string {
  const explicit = flags.as ?? process.env.SWARM_MCP_INSTANCE_ID;
  const insts = instancesInScope(scope);
  if (explicit) return resolveInstanceRef(explicit, insts);
  if (insts.length === 1) return insts[0].id;
  if (insts.length === 0) {
    throw new Error(
      `No instances registered in scope ${scope}. Pass --as <id-or-label> or set SWARM_MCP_INSTANCE_ID.`,
    );
  }
  throw new Error(
    `Multiple instances in scope ${scope}; pass --as <id-or-label>. Candidates: ${insts.map(formatInst).join(", ")}`,
  );
}

function resolveOptionalIdentity(scope: string, flags: Flags): string | null {
  const explicit = flags.as ?? process.env.SWARM_MCP_INSTANCE_ID;
  const insts = instancesInScope(scope);
  if (explicit) return resolveInstanceRef(explicit, insts);
  if (insts.length === 1) return insts[0].id;
  return null;
}

function resolveUiCommandCreator(scope: string, flags: Flags): string | null {
  if (flags.as) return resolveIdentity(scope, flags);
  const envId = process.env.SWARM_MCP_INSTANCE_ID;
  if (!envId) return resolveOptionalIdentity(scope, flags);
  try {
    return resolveInstanceRef(envId, instancesInScope(scope));
  } catch {
    return null;
  }
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function ts(n: number) {
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function idleLabel(heartbeat: number) {
  const idle = Math.max(0, Math.floor(Date.now() / 1000) - heartbeat);
  if (idle > 30) return `offline (${idle}s)`;
  if (idle > 10) return `stale (${idle}s)`;
  return `live (${idle}s)`;
}

const UI_WAIT_POLL_MS = 100;
const DEFAULT_UI_WAIT_SECS = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUiCommand(id: number, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let row = ui.get(id);
  while (
    row &&
    row.status !== "done" &&
    row.status !== "failed" &&
    Date.now() < deadline
  ) {
    await sleep(UI_WAIT_POLL_MS);
    row = ui.get(id);
  }
  return row;
}

function parseJsonMaybe(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function printUiCommand(row: ui.UiCommandRow, asJson: boolean) {
  if (asJson) {
    return printJson({
      ...row,
      payload: parseJsonMaybe(row.payload),
      result: parseJsonMaybe(row.result),
    });
  }

  console.log(
    `#${row.id}  [${row.status}]  ${row.kind}  scope=${row.scope}`,
  );
  if (row.result) {
    console.log(`  result: ${JSON.stringify(parseJsonMaybe(row.result))}`);
  }
  if (row.error) {
    console.log(`  error: ${row.error}`);
  }
}

async function maybeWaitForUiCommand(
  id: number,
  flags: Flags,
  fallbackSeconds = DEFAULT_UI_WAIT_SECS,
) {
  const waitSeconds = flags.wait ?? fallbackSeconds;
  if (waitSeconds <= 0) return ui.get(id);
  return waitForUiCommand(id, Math.round(waitSeconds * 1000));
}

async function enqueueUiCommand(
  scope: string,
  kind: ui.UiCommandKind,
  payload: Record<string, unknown>,
  flags: Flags,
  fallbackSeconds = DEFAULT_UI_WAIT_SECS,
) {
  const id = ui.enqueue(
    scope,
    kind,
    payload,
    resolveUiCommandCreator(scope, flags),
  );
  const row = await maybeWaitForUiCommand(id, flags, fallbackSeconds);
  if (!row) throw new Error(`ui command ${id} disappeared`);
  printUiCommand(row, flags.json);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdInstances(flags: Flags) {
  const scope = resolveScope(flags);
  const rows = instancesInScope(scope);
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log(`(no instances in scope ${scope})`);
  console.log(`scope: ${scope}`);
  for (const r of rows) {
    console.log(
      `  ${r.id.slice(0, 8)}  ${r.label ?? "-"}  pid=${r.pid}  ${idleLabel(r.heartbeat)}`,
    );
  }
}

function cmdMessages(flags: Flags) {
  const scope = resolveScope(flags);
  const limit = flags.limit ?? 50;
  const where: string[] = ["scope = ?"];
  const args: (string | number)[] = [scope];
  if (flags.to) {
    const insts = instancesInScope(scope);
    where.push("recipient = ?");
    args.push(resolveInstanceRef(flags.to, insts));
  }
  if (flags.from) {
    const insts = instancesInScope(scope);
    where.push("sender = ?");
    args.push(resolveInstanceRef(flags.from, insts));
  }
  args.push(limit);
  const rows = db
    .query(
      `SELECT id, sender, recipient, content, created_at, read
       FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...args) as Array<{
      id: number;
      sender: string;
      recipient: string;
      content: string;
      created_at: number;
      read: number;
    }>;
  rows.reverse();
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log("(no messages)");
  for (const r of rows) {
    const readMark = r.read ? " " : "*";
    console.log(
      `${readMark} #${r.id}  ${ts(r.created_at)}  ${r.sender.slice(0, 8)} → ${r.recipient.slice(0, 8)}`,
    );
    for (const line of r.content.split("\n")) console.log(`    ${line}`);
  }
}

function cmdTasks(flags: Flags) {
  const scope = resolveScope(flags);
  const where: string[] = ["scope = ?"];
  const args: (string | number)[] = [scope];
  if (flags.status) {
    where.push("status = ?");
    args.push(flags.status);
  }
  const rows = db
    .query(
      `SELECT id, type, title, status, assignee, requester, priority, created_at
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC`,
    )
    .all(...args);
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log("(no tasks)");
  for (const r of rows as Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    assignee: string | null;
    requester: string;
    priority: number;
  }>) {
    const who = r.assignee ? r.assignee.slice(0, 8) : "-";
    console.log(
      `  ${r.id.slice(0, 8)}  [${r.status}]  ${r.type}  p${r.priority}  assignee=${who}  ${r.title}`,
    );
  }
}

function cmdContext(flags: Flags) {
  const scope = resolveScope(flags);
  const rows = db
    .query(
      `SELECT id, instance_id, file, type, content, created_at
       FROM context
       WHERE scope = ?
       ORDER BY created_at ASC`,
    )
    .all(scope) as Array<{
      id: string;
      instance_id: string;
      file: string;
      type: string;
      content: string;
      created_at: number;
    }>;
  if (flags.json) return printJson(rows);
  if (!rows.length) return console.log("(no context entries)");
  for (const r of rows) {
    console.log(
      `  [${r.type}] ${r.instance_id.slice(0, 8)}  ${r.file}  — ${r.content}`,
    );
  }
}

function cmdKv(flags: Flags) {
  const [sub, ...rest] = flags.positional.slice(1);
  const scope = resolveScope(flags);
  if (!sub || sub === "list") {
    const rows = kv.keys(scope, flags.prefix) as Array<{
      key: string;
      updated_at: number;
    }>;
    if (flags.json) return printJson(rows);
    if (!rows.length) return console.log("(no kv entries)");
    for (const r of rows) console.log(`  ${r.key}  (${ts(r.updated_at)})`);
    return;
  }
  if (sub === "get") {
    const key = rest[0];
    if (!key) throw new Error("kv get <key>");
    const row = kv.get(scope, key);
    if (!row) {
      if (flags.json) return printJson(null);
      process.exit(1);
    }
    if (flags.json) return printJson(row);
    console.log(row.value);
    return;
  }
  if (sub === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) throw new Error("kv set <key> <value>");
    const actor = resolveIdentity(scope, flags);
    kv.set(scope, key, value, actor);
    if (flags.json) return printJson({ ok: true, key });
    console.log(`set ${key}`);
    return;
  }
  if (sub === "append") {
    const [key, value] = rest;
    if (!key || value === undefined) {
      throw new Error("kv append <key> <json-value>");
    }
    const actor = resolveIdentity(scope, flags);
    const length = kv.append(scope, key, value, actor);
    if (flags.json) return printJson({ ok: true, key, length });
    console.log(`appended to ${key} (length=${length})`);
    return;
  }
  if (sub === "del") {
    const key = rest[0];
    if (!key) throw new Error("kv del <key>");
    const actor = resolveIdentity(scope, flags);
    kv.del(scope, key, actor);
    if (flags.json) return printJson({ ok: true, key });
    console.log(`deleted ${key}`);
    return;
  }
  throw new Error(`Unknown kv subcommand: ${sub}`);
}

function cmdSend(flags: Flags) {
  const content = flags.positional.slice(1).join(" ");
  if (!flags.to) throw new Error("send requires --to <id-or-label>");
  if (!content) throw new Error("send requires content");
  const scope = resolveScope(flags);
  const sender = resolveIdentity(scope, flags);
  const insts = instancesInScope(scope);
  const recipient = resolveInstanceRef(flags.to, insts);
  messages.send(sender, scope, recipient, content);
  if (flags.json) {
    return printJson({ ok: true, sender, recipient, scope });
  }
  console.log(`sent ${sender.slice(0, 8)} → ${recipient.slice(0, 8)}`);
}

function cmdBroadcast(flags: Flags) {
  const content = flags.positional.slice(1).join(" ");
  if (!content) throw new Error("broadcast requires content");
  const scope = resolveScope(flags);
  const sender = resolveIdentity(scope, flags);
  const count = messages.broadcast(sender, scope, content);
  if (flags.json) return printJson({ ok: true, sender, scope, count });
  console.log(`broadcast to ${count} recipient(s)`);
}

function cmdLock(flags: Flags) {
  const file = flags.positional[1];
  if (!file) throw new Error("lock <file>");
  const scope = resolveScope(flags);
  const inst = resolveIdentity(scope, flags);
  const res = context.lock(inst, scope, file, flags.note ?? "");
  if ("error" in res) {
    if (flags.json) return printJson(res);
    console.error(`lock failed: ${res.error}`);
    process.exit(1);
  }
  if (flags.json) return printJson(res);
  console.log(`locked ${file}`);
}

function cmdUnlock(flags: Flags) {
  const file = flags.positional[1];
  if (!file) throw new Error("unlock <file>");
  const scope = resolveScope(flags);
  const inst = resolveIdentity(scope, flags);
  context.clearLocks(inst, scope, file);
  if (flags.json) return printJson({ ok: true, file });
  console.log(`unlocked ${file}`);
}

function cmdInspect(flags: Flags) {
  const scope = resolveScope(flags);
  const insts = instancesInScope(scope);
  const msgs = db
    .query(
      `SELECT id, sender, recipient, content, created_at, read
       FROM messages WHERE scope = ? ORDER BY id DESC LIMIT 20`,
    )
    .all(scope);
  const tsks = db
    .query(
      `SELECT id, type, title, status, assignee, requester
       FROM tasks WHERE scope = ? ORDER BY created_at ASC`,
    )
    .all(scope);
  const ctx = db
    .query(
      `SELECT id, instance_id, file, type, content, created_at
       FROM context WHERE scope = ? ORDER BY created_at ASC`,
    )
    .all(scope);
  const kvs = kv.keys(scope) as Array<{ key: string; updated_at: number }>;

  if (flags.json) {
    return printJson({
      scope,
      instances: insts,
      messages: (msgs as unknown[]).slice().reverse(),
      tasks: tsks,
      context: ctx,
      kv: kvs,
    });
  }

  console.log(`scope: ${scope}\n`);
  console.log(`instances (${insts.length}):`);
  for (const r of insts) {
    console.log(
      `  ${r.id.slice(0, 8)}  ${r.label ?? "-"}  ${idleLabel(r.heartbeat)}`,
    );
  }
  console.log(`\ntasks (${(tsks as unknown[]).length}):`);
  for (const r of tsks as Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    assignee: string | null;
  }>) {
    console.log(
      `  ${r.id.slice(0, 8)}  [${r.status}]  ${r.type}  ${r.title}`,
    );
  }
  console.log(`\ncontext (${(ctx as unknown[]).length}):`);
  for (const r of ctx as Array<{
    instance_id: string;
    file: string;
    type: string;
    content: string;
  }>) {
    console.log(
      `  [${r.type}] ${r.instance_id.slice(0, 8)}  ${r.file}  — ${r.content}`,
    );
  }
  console.log(`\nkv (${kvs.length}):`);
  for (const r of kvs) console.log(`  ${r.key}  (${ts(r.updated_at)})`);
  console.log(`\nrecent messages (${(msgs as unknown[]).length}, newest last):`);
  for (const r of (msgs as Array<{
    id: number;
    sender: string;
    recipient: string;
    content: string;
    created_at: number;
    read: number;
  }>).slice().reverse()) {
    const mark = r.read ? " " : "*";
    const head = r.content.split("\n")[0].slice(0, 80);
    console.log(
      `${mark} #${r.id}  ${ts(r.created_at)}  ${r.sender.slice(0, 8)} → ${r.recipient.slice(0, 8)}  ${head}`,
    );
  }
}

async function cmdUi(flags: Flags) {
  const [sub, ...rest] = flags.positional.slice(1);
  if (!sub || sub === "commands" || sub === "list") {
    const rows = ui.list({
      scope: flags.scope ? resolveScope(flags) : undefined,
      status: flags.status,
      limit: flags.limit,
    });
    if (flags.json) return printJson(rows.map((row) => ({
      ...row,
      payload: parseJsonMaybe(row.payload),
      result: parseJsonMaybe(row.result),
    })));
    if (!rows.length) return console.log("(no ui commands)");
    for (const row of rows.slice().reverse()) {
      console.log(
        `#${row.id}  [${row.status}]  ${row.kind}  scope=${row.scope}`,
      );
    }
    return;
  }

  if (sub === "get") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new Error("ui get <id>");
    const row = ui.get(id);
    if (!row) {
      if (flags.json) return printJson(null);
      process.exit(1);
    }
    return printUiCommand(row, flags.json);
  }

  if (sub === "spawn") {
    const cwd = rest[0];
    if (!cwd) {
      throw new Error(
        "ui spawn <cwd> [--harness <claude|codex|opencode>] [--role <role>] [--label <tokens>] [--scope <path>] [--wait <seconds>]",
      );
    }
    const scope = scopeFor(cwd, flags.scope);
    return enqueueUiCommand(
      scope,
      "spawn_shell",
      {
        cwd,
        harness: flags.harness ?? null,
        role: flags.role ?? null,
        label: flags.label ?? null,
      },
      flags,
    );
  }

  if (sub === "prompt") {
    const content = rest.join(" ");
    if (!flags.target) {
      throw new Error(
        "ui prompt --target <node|instance|pty> <content...> [--no-enter] [--scope <path>] [--wait <seconds>]",
      );
    }
    if (!content) throw new Error("ui prompt requires content");
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "send_prompt",
      {
        target: flags.target,
        text: content,
        enter: flags.enter,
      },
      flags,
    );
  }

  if (sub === "kill") {
    if (!flags.target) {
      throw new Error(
        "ui kill --target <instance-id-or-label> [--scope <path>] [--wait <seconds>]",
      );
    }
    const scope = resolveScope(flags);
    const instanceId = resolveInstanceRef(flags.target, instancesInScope(scope));
    return enqueueUiCommand(
      scope,
      "kill_instance",
      {
        instance_id: instanceId,
      },
      flags,
    );
  }

  if (sub === "move") {
    if (!flags.target || !Number.isFinite(flags.x) || !Number.isFinite(flags.y)) {
      throw new Error(
        "ui move --target <node|instance|pty> --x <number> --y <number> [--scope <path>] [--wait <seconds>]",
      );
    }
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "move_node",
      {
        target: flags.target,
        x: flags.x,
        y: flags.y,
      },
      flags,
    );
  }

  if (sub === "organize") {
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "organize_nodes",
      {
        kind: flags.kind ?? "grid",
      },
      flags,
    );
  }

  if (sub === "export-layout") {
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "ui.export-layout",
      {
        scope,
        out: flags.out ?? null,
      },
      flags,
    );
  }

  if (sub === "screenshot") {
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "ui.screenshot",
      {
        out: flags.out ?? null,
      },
      flags,
    );
  }

  if (sub === "proof-pack") {
    const scope = resolveScope(flags);
    return enqueueUiCommand(
      scope,
      "ui.proof-pack",
      {
        out: flags.out ?? null,
        note: flags.note ?? null,
        surface: flags.surface ?? "cli",
      },
      flags,
    );
  }

  throw new Error(`Unknown ui subcommand: ${sub}`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, (flags: Flags) => void | Promise<void>> = {
  instances: cmdInstances,
  messages: cmdMessages,
  tasks: cmdTasks,
  context: cmdContext,
  kv: cmdKv,
  send: cmdSend,
  broadcast: cmdBroadcast,
  lock: cmdLock,
  unlock: cmdUnlock,
  inspect: cmdInspect,
  ui: cmdUi,
};

export const SUBCOMMANDS = Object.keys(HANDLERS);

export async function run(subcommand: string, argv: string[]) {
  const handler = HANDLERS[subcommand];
  if (!handler) throw new Error(`Unknown subcommand: ${subcommand}`);
  // Drop stale instances before any read/write so the CLI sees the same world a live agent would.
  registry.prune();
  try {
    const flags = parseFlags([subcommand, ...argv]);
    await handler(flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`swarm-mcp ${subcommand}: ${msg}`);
    process.exit(1);
  }
}
