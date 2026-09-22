import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexContextItem,
  hasCodexContext,
} from "../src/coordination/codex-context";

test("Codex retained context requires native identity and exact injected item, and rejects rewritten history", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-context-"));
  const thread = "019abcde-1234-5678-abcd-0123456789ab";
  const path = join(root, `rollout-${thread}.jsonl`);
  const lease = {
    message: {
      id: "message",
      recipient: "actor",
      kind: "question",
      body: "Do the work",
    },
    leaseToken: "token",
    leaseUntil: 100,
    attempt: 1,
  };
  const meta = { type: "session_meta", payload: { id: thread, cwd: root } };
  const item = codexContextItem(lease, false);
  const write = (...rows: unknown[]) =>
    writeFileSync(
      path,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
  const check = () =>
    hasCodexContext(
      path,
      thread,
      root,
      lease.message,
      new AbortController().signal,
    );
  write(meta, { type: "response_item", payload: { ...item, id: null } });
  expect(await check()).toBe(false);
  write(meta, { type: "response_item", payload: item });
  expect(await check()).toBe(true);
  expect(
    await hasCodexContext(
      path,
      thread,
      root,
      { ...lease.message, body: "Changed" },
      new AbortController().signal,
    ),
  ).toBe(false);
  write(
    meta,
    { type: "response_item", payload: item },
    { type: "compacted", payload: {} },
  );
  await expect(check()).rejects.toThrow("rewritten");
  write(
    meta,
    { type: "response_item", payload: item },
    { type: "event_msg", payload: { type: "thread_rolled_back" } },
  );
  await expect(check()).rejects.toThrow("rewritten");
  write(
    { type: "session_meta", payload: { id: "wrong", cwd: root } },
    { type: "response_item", payload: item },
  );
  await expect(check()).rejects.toThrow("identity");
  writeFileSync(path, JSON.stringify(meta) + "\n{");
  await expect(check()).rejects.toThrow();
  expect(codexContextItem(lease, true).content[0].text).not.toContain(
    lease.message.body,
  );
});
