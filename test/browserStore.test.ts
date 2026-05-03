import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedBrowserContext } from "../src/browser";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-browser-store-")),
  "swarm.db",
);

const { db } = await import("../src/db");
const browserStore = await import("../src/browserStore");

const SCOPE = "/tmp/browser-store-scope";
const ACTOR = "agent-1";

const managed: ManagedBrowserContext = {
  id: "ctx-1",
  endpoint: {
    host: "127.0.0.1",
    port: 9333,
    baseUrl: "http://127.0.0.1:9333",
  },
  profileDir: "/tmp/swarm-browser-profile",
  pid: 12345,
  startUrl: "https://example.com",
};

beforeEach(() => {
  db.exec("DELETE FROM browser_snapshots");
  db.exec("DELETE FROM browser_tabs");
  db.exec("DELETE FROM browser_contexts");
  db.exec("DELETE FROM events");
});

describe("browserStore", () => {
  test("persists and closes managed browser contexts", () => {
    const row = browserStore.upsertContext(SCOPE, ACTOR, managed);

    expect(row).toMatchObject({
      scope: SCOPE,
      id: managed.id,
      owner_instance_id: ACTOR,
      endpoint: managed.endpoint.baseUrl,
      host: managed.endpoint.host,
      port: managed.endpoint.port,
      profile_dir: managed.profileDir,
      pid: managed.pid,
      start_url: managed.startUrl,
      status: "open",
    });

    expect(browserStore.listContexts(SCOPE)).toHaveLength(1);

    const closed = browserStore.markContextClosed(SCOPE, managed.id, ACTOR);
    expect(closed?.status).toBe("closed");
  });

  test("persists tab snapshots and removes stale tab rows", () => {
    browserStore.upsertContext(SCOPE, ACTOR, managed);

    browserStore.recordTabs(SCOPE, managed.id, [
      {
        id: "tab-1",
        type: "page",
        url: "https://example.com",
        title: "Example",
        active: true,
      },
      {
        id: "tab-2",
        type: "page",
        url: "https://example.com/two",
        title: "Second",
        active: false,
      },
    ], ACTOR);

    expect(browserStore.listTabs(SCOPE, managed.id).map((tab) => tab.tab_id))
      .toEqual(["tab-1", "tab-2"]);

    browserStore.recordTabs(SCOPE, managed.id, [
      {
        id: "tab-2",
        type: "page",
        url: "https://example.com/two-updated",
        title: "Second Updated",
        active: true,
      },
    ], ACTOR);

    const tabs = browserStore.listTabs(SCOPE, managed.id);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      tab_id: "tab-2",
      url: "https://example.com/two-updated",
      active: 1,
    });
  });

  test("persists browser snapshots with parsed elements", () => {
    browserStore.upsertContext(SCOPE, ACTOR, managed);

    const snapshot = browserStore.recordSnapshot(
      SCOPE,
      managed.id,
      {
        tabId: "tab-1",
        url: "https://example.com",
        title: "Example",
        text: "Hello Browser",
        elements: [
          {
            tag: "button",
            role: null,
            text: "Launch",
            selector: "button",
          },
        ],
        screenshotPath: "/tmp/browser.png",
        capturedAtUnixMs: 1,
      },
      ACTOR,
    );

    expect(snapshot).toMatchObject({
      scope: SCOPE,
      context_id: managed.id,
      tab_id: "tab-1",
      text: "Hello Browser",
      screenshot_path: "/tmp/browser.png",
      created_by: ACTOR,
    });
    expect(snapshot.elements[0]).toMatchObject({
      tag: "button",
      text: "Launch",
      selector: "button",
    });
    expect(browserStore.listSnapshots(SCOPE, managed.id, 10)).toHaveLength(1);
  });
});
