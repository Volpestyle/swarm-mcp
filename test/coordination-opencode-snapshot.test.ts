import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { listOpenCodeSessions } from "../src/coordination/opencode-snapshot";

test("SDK snapshot reads large histories without losing timestamp ties", async () => {
  const directory = "C:/fixture";
  const rows = Array.from({ length: 1500 }, (_, index) => ({
    id: `session-${index}`,
    directory,
    time: { updated: index < 400 ? 2000 : 2000 - index },
  }));
  let requests = 0;
  let largestPage = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/experimental/session");
      expect(url.searchParams.get("directory")).toBe(directory);
      const cursor = Number(url.searchParams.get("cursor") ?? Infinity);
      const limit = Number(url.searchParams.get("limit"));
      largestPage = Math.max(largestPage, limit);
      requests++;
      const eligible = rows.filter((row) => row.time.updated < cursor);
      const page = eligible.slice(0, limit);
      return Response.json(page, {
        headers:
          eligible.length > limit
            ? { "x-next-cursor": String(page.at(-1)!.time.updated) }
            : {},
      });
    },
  });
  try {
    const api = createOpencodeClient({ baseUrl: server.url.href });
    const result = await listOpenCodeSessions(
      api,
      directory,
      AbortSignal.timeout(5000),
    );
    expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(largestPage).toBe(800);
    expect(requests).toBeLessThan(25);
  } finally {
    server.stop(true);
  }
});

test("SDK snapshot refuses malformed cursors and saturated timestamp groups", async () => {
  let malformed = true;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return Response.json(
        [{ id: "one", directory: "fixture", time: { updated: 10 } }],
        {
          headers: { "x-next-cursor": malformed ? "wrong" : "10" },
        },
      );
    },
  });
  try {
    const api = createOpencodeClient({ baseUrl: server.url.href });
    await expect(
      listOpenCodeSessions(api, "fixture", AbortSignal.timeout(5000)),
    ).rejects.toThrow("Invalid session snapshot cursor");
    malformed = false;
    await expect(
      listOpenCodeSessions(api, "fixture", AbortSignal.timeout(5000)),
    ).rejects.toThrow("Session timestamp group exceeds snapshot page budget");
    expect(requests).toBeLessThan(12);
  } finally {
    server.stop(true);
  }
});
