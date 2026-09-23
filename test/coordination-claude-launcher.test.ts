import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeHookSettings,
  prepareClaudeLaunch,
} from "../src/coordination/claude-launcher";

test("Claude hook settings preserve existing hooks and quote literal paths through the real shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-hook-path-"));
  const hookPath = join(root, "hook ' $(printf injected).mjs");
  writeFileSync(hookPath, 'process.stdout.write("hook-ok")');
  const prior = {
    model: "keep-model",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }],
      Stop: [],
    },
  };
  const before = JSON.stringify(prior);
  const settings = claudeHookSettings(Bun.which("node")!, hookPath, prior);
  expect(JSON.stringify(prior)).toBe(before);
  expect(settings.model).toBe("keep-model");
  const hooks = settings.hooks as Record<
    string,
    Array<{ hooks: Array<{ command: string }> }>
  >;
  expect(hooks.SessionStart.length).toBe(2);
  expect(hooks.SessionStart[0].hooks[0].command).toBe("existing");
  expect(hooks.Stop).toEqual([]);
  const shell =
    process.platform === "win32"
      ? (process.env.CLAUDE_CODE_GIT_BASH_PATH ??
        "C:/Program Files/Git/bin/bash.exe")
      : Bun.which("bash")!;
  const child = Bun.spawn({
    cmd: [
      shell,
      "--noprofile",
      "--norc",
      "-c",
      hooks.SessionStart[1].hooks[0].command,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stdout, stderr }).toEqual({
    exit: 0,
    stdout: "hook-ok",
    stderr: "",
  });
  expect(() =>
    claudeHookSettings(Bun.which("node")!, hookPath, { disableAllHooks: true }),
  ).toThrow("disabled");
  expect(() =>
    claudeHookSettings(Bun.which("node")!, hookPath, {
      hooks: { SessionStart: "bad" },
    }),
  ).toThrow("array");
});

test("Claude launcher rejects invalid native identity before starting an owner", async () => {
  await expect(
    prepareClaudeLaunch({ hostSessionId: "not-a-uuid" } as Parameters<
      typeof prepareClaudeLaunch
    >[0]),
  ).rejects.toThrow("UUID");
});
