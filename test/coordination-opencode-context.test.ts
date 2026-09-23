import { expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  hasOpenCodeContext,
  OPENCODE_PEER_PREFIX,
} from "../src/coordination/opencode-context";

test("OpenCode context proof pages history and respects pruning, revert and compaction", async () => {
  const message = { id: "peer", body: "work" };
  const output =
    "tool result" + OPENCODE_PEER_PREFIX + JSON.stringify({ message });
  const part = {
    id: "p1",
    sessionID: "s",
    messageID: "m1",
    type: "tool",
    state: {
      status: "completed",
      output,
      time: {},
    },
  };
  const item = {
    info: { id: "m1", sessionID: "s", role: "assistant" },
    parts: [part],
  };
  let older: unknown[] = [item];
  let revert: unknown;
  let repeatCursor = false;
  let pages = 0;
  const api = createOpencodeClient({
    baseUrl: "http://fixture",
    fetch: (async (request: Request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/message"))
        return Response.json({ time: {}, revert });
      pages++;
      if (url.searchParams.has("before"))
        return Response.json(older, {
          headers: repeatCursor ? { "x-next-cursor": "older" } : {},
        });
      return Response.json(
        [{ info: { id: "m2", sessionID: "s", role: "user" }, parts: [] }],
        {
          headers: { "x-next-cursor": "older" },
        },
      );
    }) as typeof fetch,
  });
  const inspect = () =>
    hasOpenCodeContext(api, "s", message, AbortSignal.timeout(1000));
  expect(await inspect()).toBe(true);
  expect(pages).toBe(2);
  const textPart = {
    id: "p1",
    sessionID: "s",
    messageID: "m1",
    type: "text",
    text: output,
  };
  older = [
    { ...item, info: { ...item.info, role: "user" }, parts: [textPart] },
  ];
  expect(await inspect()).toBe(true);
  older = [{ ...item, parts: [textPart] }];
  expect(await inspect()).toBe(false);
  older = [
    {
      ...item,
      info: { ...item.info, role: "user" },
      parts: [{ ...textPart, ignored: true }],
    },
  ];
  expect(await inspect()).toBe(false);
  older = [
    {
      ...item,
      parts: [{ ...part, state: { ...part.state, time: { compacted: 1 } } }],
    },
  ];
  expect(await inspect()).toBe(false);
  older = [item];
  revert = { messageID: "m1" };
  expect(await inspect()).toBe(false);
  revert = undefined;
  older = [
    item,
    {
      info: { id: "m2", sessionID: "s", role: "assistant", summary: true },
      parts: [],
    },
  ];
  expect(await inspect()).toBe(false);
  older = [{ ...item, info: { ...item.info, sessionID: "other" } }];
  await expect(inspect()).rejects.toThrow("crossed session boundary");
  older = [{ ...item, parts: [] }];
  repeatCursor = true;
  await expect(inspect()).rejects.toThrow("cursor did not advance");
});
