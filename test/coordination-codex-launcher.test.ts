import { expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resumeCodexThread,
  resumeCodexRuntime,
} from "../src/coordination/codex-launcher";

test("Codex resume rejects mismatched workspaces and loaded threads before enrollment", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-guards-"));
  const threadId = "019abcde-1234-5678-abcd-0123456789ab";
  const options = {
    stateDirectory: join(root, "must-not-exist"),
    nodePath: process.execPath,
    ownerPath: resolve("src/coordination/owner-cli.ts"),
    mcpPath: resolve("src/coordination/mcp-cli.ts"),
    hostSessionId: threadId,
    incarnation: "first",
    identity: {
      projectRoot: root,
      directory: root,
      fileRoot: root,
      profile: "fixture",
      allowedRoots: [root],
    },
  };
  await expect(
    resumeCodexThread(options, async () => ({
      thread: { id: threadId, cwd: tmpdir() },
    })),
  ).rejects.toThrow("workspace");
  const methods: string[] = [];
  await expect(
    resumeCodexThread(options, async (method, params) => {
      methods.push(method);
      if (method === "thread/read")
        return { thread: { id: threadId, cwd: root } };
      if (!params.cursor) return { data: [], nextCursor: "second-page" };
      return { data: [threadId], nextCursor: null };
    }),
  ).rejects.toThrow("already loaded");
  expect(methods).toEqual([
    "thread/read",
    "thread/loaded/list",
    "thread/loaded/list",
  ]);
  expect(existsSync(options.stateDirectory)).toBe(false);
  let subscribed = false;
  let detached = false;
  await expect(
    resumeCodexRuntime(options, {
      subscribe() {
        subscribed = true;
        return () => {
          detached = true;
        };
      },
      async call() {
        expect(subscribed).toBe(true);
        throw new Error("Native host unavailable");
      },
    }),
  ).rejects.toThrow("Native host unavailable");
  expect(detached).toBe(true);
  expect(existsSync(options.stateDirectory)).toBe(false);
  await expect(
    resumeCodexThread(options, async (method) =>
      method === "thread/read"
        ? { thread: { id: threadId, cwd: root } }
        : { data: [], nextCursor: "loop" },
    ),
  ).rejects.toThrow("cursor repeated");
  expect(existsSync(options.stateDirectory)).toBe(false);
});
