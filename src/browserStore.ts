import { randomUUID } from "node:crypto";
import type {
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserTab,
  ManagedBrowserContext,
} from "./browser";
import { db } from "./db";
import { emit } from "./events";

export type BrowserContextStatus = "open" | "closed" | "unknown";

export type BrowserContextRow = {
  scope: string;
  id: string;
  owner_instance_id: string | null;
  endpoint: string;
  host: string;
  port: number;
  profile_dir: string;
  pid: number | null;
  start_url: string;
  status: BrowserContextStatus;
  created_at: number;
  updated_at: number;
};

export type BrowserTabRow = {
  scope: string;
  context_id: string;
  tab_id: string;
  type: string;
  url: string;
  title: string;
  active: number;
  updated_at: number;
};

export type BrowserSnapshotRow = {
  id: string;
  scope: string;
  context_id: string;
  tab_id: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserSnapshotElement[];
  screenshot_path: string | null;
  created_by: string | null;
  created_at: number;
};

export function upsertContext(
  scope: string,
  ownerInstanceId: string,
  context: ManagedBrowserContext,
  status: BrowserContextStatus = "open",
): BrowserContextRow {
  db.run(
    `INSERT INTO browser_contexts
       (scope, id, owner_instance_id, endpoint, host, port, profile_dir, pid, start_url, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(scope, id) DO UPDATE SET
       owner_instance_id = excluded.owner_instance_id,
       endpoint = excluded.endpoint,
       host = excluded.host,
       port = excluded.port,
       profile_dir = excluded.profile_dir,
       pid = excluded.pid,
       start_url = excluded.start_url,
       status = excluded.status,
       updated_at = unixepoch()`,
    [
      scope,
      context.id,
      ownerInstanceId,
      context.endpoint.baseUrl,
      context.endpoint.host,
      context.endpoint.port,
      context.profileDir,
      context.pid,
      context.startUrl,
      status,
    ],
  );
  emit({
    scope,
    type: "browser.context.upserted",
    actor: ownerInstanceId,
    subject: context.id,
    payload: {
      endpoint: context.endpoint.baseUrl,
      status,
    },
  });
  return getContext(scope, context.id)!;
}

export function markContextClosed(
  scope: string,
  contextId: string,
  actor?: string | null,
): BrowserContextRow | null {
  db.run(
    `UPDATE browser_contexts
     SET status = 'closed', updated_at = unixepoch()
     WHERE scope = ? AND id = ?`,
    [scope, contextId],
  );
  emit({
    scope,
    type: "browser.context.closed",
    actor: actor ?? null,
    subject: contextId,
  });
  return getContext(scope, contextId);
}

export function getContext(
  scope: string,
  contextId: string,
): BrowserContextRow | null {
  return db
    .query(
      `SELECT scope, id, owner_instance_id, endpoint, host, port, profile_dir,
              pid, start_url, status, created_at, updated_at
       FROM browser_contexts
       WHERE scope = ? AND id = ?`,
    )
    .get(scope, contextId) as BrowserContextRow | null;
}

export function listContexts(scope: string): BrowserContextRow[] {
  return db
    .query(
      `SELECT scope, id, owner_instance_id, endpoint, host, port, profile_dir,
              pid, start_url, status, created_at, updated_at
       FROM browser_contexts
       WHERE scope = ?
       ORDER BY updated_at DESC, created_at DESC, id ASC`,
    )
    .all(scope) as BrowserContextRow[];
}

export function recordTabs(
  scope: string,
  contextId: string,
  tabs: BrowserTab[],
  actor?: string | null,
): BrowserTabRow[] {
  const tx = db.transaction(() => {
    if (!tabs.length) {
      db.run("DELETE FROM browser_tabs WHERE scope = ? AND context_id = ?", [
        scope,
        contextId,
      ]);
      return;
    }

    const tabIds = tabs.map((tab) => tab.id);
    const marks = tabIds.map(() => "?").join(",");
    db.run(
      `DELETE FROM browser_tabs
       WHERE scope = ? AND context_id = ? AND tab_id NOT IN (${marks})`,
      [scope, contextId, ...tabIds],
    );

    for (const tab of tabs) {
      db.run(
        `INSERT INTO browser_tabs
           (scope, context_id, tab_id, type, url, title, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(scope, context_id, tab_id) DO UPDATE SET
           type = excluded.type,
           url = excluded.url,
           title = excluded.title,
           active = excluded.active,
           updated_at = unixepoch()`,
        [
          scope,
          contextId,
          tab.id,
          tab.type,
          tab.url,
          tab.title,
          tab.active ? 1 : 0,
        ],
      );
    }
  });
  tx();
  emit({
    scope,
    type: "browser.tabs.updated",
    actor: actor ?? null,
    subject: contextId,
    payload: { count: tabs.length },
  });
  return listTabs(scope, contextId);
}

export function listTabs(scope: string, contextId: string): BrowserTabRow[] {
  return db
    .query(
      `SELECT scope, context_id, tab_id, type, url, title, active, updated_at
       FROM browser_tabs
       WHERE scope = ? AND context_id = ?
       ORDER BY active DESC, updated_at DESC, tab_id ASC`,
    )
    .all(scope, contextId) as BrowserTabRow[];
}

export function recordSnapshot(
  scope: string,
  contextId: string,
  snapshot: BrowserSnapshot,
  actor?: string | null,
): BrowserSnapshotRow {
  const id = randomUUID();
  const elementsJson = JSON.stringify(snapshot.elements);
  db.run(
    `INSERT INTO browser_snapshots
       (id, scope, context_id, tab_id, url, title, text, elements_json, screenshot_path, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scope,
      contextId,
      snapshot.tabId,
      snapshot.url,
      snapshot.title,
      snapshot.text,
      elementsJson,
      snapshot.screenshotPath ?? null,
      actor ?? null,
    ],
  );
  emit({
    scope,
    type: "browser.snapshot.captured",
    actor: actor ?? null,
    subject: contextId,
    payload: {
      snapshot_id: id,
      tab_id: snapshot.tabId,
      text_length: snapshot.text.length,
      elements: snapshot.elements.length,
      screenshot_path: snapshot.screenshotPath ?? null,
    },
  });
  return getSnapshot(scope, id)!;
}

export function getSnapshot(
  scope: string,
  snapshotId: string,
): BrowserSnapshotRow | null {
  const row = db
    .query(
      `SELECT id, scope, context_id, tab_id, url, title, text, elements_json,
              screenshot_path, created_by, created_at
       FROM browser_snapshots
       WHERE scope = ? AND id = ?`,
    )
    .get(scope, snapshotId) as
    | (Omit<BrowserSnapshotRow, "elements"> & { elements_json: string })
    | null;
  return row ? normalizeSnapshotRow(row) : null;
}

export function listSnapshots(
  scope: string,
  contextId?: string,
  limit = 20,
): BrowserSnapshotRow[] {
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const rows = contextId
    ? db
        .query(
          `SELECT id, scope, context_id, tab_id, url, title, text, elements_json,
                  screenshot_path, created_by, created_at
           FROM browser_snapshots
           WHERE scope = ? AND context_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(scope, contextId, boundedLimit)
    : db
        .query(
          `SELECT id, scope, context_id, tab_id, url, title, text, elements_json,
                  screenshot_path, created_by, created_at
           FROM browser_snapshots
           WHERE scope = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(scope, boundedLimit);

  return (rows as Array<Omit<BrowserSnapshotRow, "elements"> & {
    elements_json: string;
  }>).map(normalizeSnapshotRow);
}

function normalizeSnapshotRow(
  row: Omit<BrowserSnapshotRow, "elements"> & { elements_json: string },
): BrowserSnapshotRow {
  let elements: BrowserSnapshotElement[] = [];
  try {
    const parsed = JSON.parse(row.elements_json);
    if (Array.isArray(parsed)) {
      elements = parsed.map((item) => ({
        tag:
          item && typeof item === "object" && typeof item.tag === "string"
            ? item.tag
            : "",
        role:
          item && typeof item === "object" && typeof item.role === "string"
            ? item.role
            : null,
        text:
          item && typeof item === "object" && typeof item.text === "string"
            ? item.text
            : "",
        selector:
          item && typeof item === "object" && typeof item.selector === "string"
            ? item.selector
            : "",
      }));
    }
  } catch {
    elements = [];
  }

  return {
    id: row.id,
    scope: row.scope,
    context_id: row.context_id,
    tab_id: row.tab_id,
    url: row.url,
    title: row.title,
    text: row.text,
    elements,
    screenshot_path: row.screenshot_path,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}
