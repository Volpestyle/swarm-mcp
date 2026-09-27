import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAUDE_PEER_PREFIX,
  hasClaudeContext,
} from "../src/coordination/claude-context";

test("Claude context proof follows the active branch and excludes quotes and compaction", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "claude-context-")),
    "session.jsonl",
  );
  const message = { id: "peer", body: "work", recipient: "alice" };
  const hook = {
    sessionId: "session",
    uuid: "hook",
    parentUuid: "root",
    type: "attachment",
    attachment: {
      type: "hook_additional_context",
      hookEvent: "PostToolUse",
      content: [CLAUDE_PEER_PREFIX + JSON.stringify({ message })],
    },
  };
  const root = {
    sessionId: "session",
    uuid: "root",
    parentUuid: null,
    type: "user",
  };
  const check = async (rows: object[]) => {
    writeFileSync(
      path,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    return hasClaudeContext(
      path,
      "session",
      message,
      AbortSignal.timeout(1000),
    );
  };
  expect(
    await check([
      root,
      hook,
      { ...root, uuid: "reply", parentUuid: "hook", type: "assistant" },
    ]),
  ).toBe(true);
  expect(
    await check([
      root,
      hook,
      { ...root, uuid: "other-branch", parentUuid: "root" },
    ]),
  ).toBe(false);
  expect(await check([root, { ...hook, type: "user" }])).toBe(false);
  expect(await check([root, { ...hook, sessionId: "other" }])).toBe(false);
  expect(await check([root, { ...hook, isSidechain: true }])).toBe(false);
  expect(
    await check([
      root,
      hook,
      {
        ...root,
        uuid: "compact",
        parentUuid: "hook",
        type: "system",
        subtype: "compact_boundary",
      },
    ]),
  ).toBe(false);
  expect(
    await check([
      root,
      {
        ...hook,
        attachment: {
          ...hook.attachment,
          content: [
            CLAUDE_PEER_PREFIX +
              JSON.stringify({ message: { ...message, body: "other" } }),
          ],
        },
      },
    ]),
  ).toBe(false);
  writeFileSync(path, '{"partial":');
  await expect(
    hasClaudeContext(path, "session", message, AbortSignal.timeout(1000)),
  ).rejects.toThrow();
  await expect(
    hasClaudeContext(path, "other", message, AbortSignal.timeout(1000)),
  ).rejects.toThrow("Invalid Claude transcript binding");
});

test("transcripts beyond the inspection budget are read from their tail, never refused (VUH-1406)", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "claude-context-large-")),
    "session.jsonl",
  );
  const message = { id: "peer", body: "work", recipient: "alice" };
  // One row larger than the whole budget pushes everything before it out of
  // the inspected window, as a long worker session's tool output does.
  const root = {
    sessionId: "session",
    uuid: "root",
    parentUuid: null,
    type: "user",
    padding: "x".repeat(17 * 1024 * 1024),
  };
  const hook = {
    sessionId: "session",
    uuid: "hook",
    parentUuid: "root",
    type: "attachment",
    attachment: {
      type: "hook_additional_context",
      hookEvent: "PostToolUse",
      content: [CLAUDE_PEER_PREFIX + JSON.stringify({ message })],
    },
  };
  const check = (rows: object[]) => {
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return hasClaudeContext(path, "session", message, AbortSignal.timeout(5000));
  };
  // A proof inside the window still counts.
  expect(
    await check([
      root,
      hook,
      { sessionId: "session", uuid: "reply", parentUuid: "hook", type: "assistant" },
    ]),
  ).toBe(true);
  // An ancestry that leaves the window is unproven: deliver again.
  expect(
    await check([
      root,
      { sessionId: "session", uuid: "other", parentUuid: "root", type: "user" },
    ]),
  ).toBe(false);
  // A single row bigger than the window proves nothing and is not an error.
  expect(await check([root])).toBe(false);
});
