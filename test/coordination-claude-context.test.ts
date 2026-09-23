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
