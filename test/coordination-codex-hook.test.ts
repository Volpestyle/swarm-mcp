import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHook } from "../src/coordination/codex-hook";
import { hasCodexContext, CODEX_PEER_PREFIX } from "../src/coordination/codex-context";
import {
  codexHookOverrides,
  codexHookTrustHash,
} from "../src/coordination/codex-launcher";

const unused = { endpoint: "must-not-connect", capability: "must-not-use" };

test("unsupported Codex events cannot claim a delivery boundary", async () => {
  for (const hook_event_name of ["SessionStart", "SessionEnd", "Stop", "PreToolUse"])
    expect(
      await codexHook({ session_id: "thread", cwd: "/", hook_event_name }, unused),
    ).toEqual({});
});

test("Codex subagent hooks leave the parent's deliveries pending", async () => {
  for (const hook_event_name of ["UserPromptSubmit", "PostToolUse"])
    expect(
      await codexHook(
        { session_id: "thread", cwd: "/", hook_event_name, agent_id: "sub" },
        unused,
      ),
    ).toEqual({});
});

test("Codex hooks refuse input without a native session binding", async () => {
  await expect(
    codexHook({ session_id: "", cwd: "/", hook_event_name: "PostToolUse" }, unused),
  ).rejects.toThrow("native session binding");
});

test("Codex trust hash matches a hash Codex 0.159.1 wrote for a trusted hook", () => {
  // Recorded from ~/.codex/config.toml after trusting a probe hook passed as
  // -c hooks.UserPromptSubmit=[{hooks=[{type="command",command=...,timeout=10}]}].
  expect(
    codexHookTrustHash(
      "user_prompt_submit",
      "node C:/Users/volpe/AppData/Local/Temp/claude/C--Users-volpe-repos-rivals-agent/2c096147-bff2-4e70-b28c-5999da58f6b1/scratchpad/codex-hook-probe/probe.js",
      10,
    ),
  ).toBe(
    "sha256:94f49c3fe835daa1b118193b811e549ae4fcf08c169173ec60ee32200c663c62",
  );
});

test("Codex hook overrides install and pre-trust both delivery events", () => {
  const node = process.execPath;
  const hook = join(import.meta.dir, "coordination-codex-hook.test.ts");
  const args = codexHookOverrides(node, hook);
  const values = args.filter((_, index) => index % 2 === 1);
  expect(args.filter((_, index) => index % 2 === 0).every((flag) => flag === "-c")).toBe(true);
  expect(values.some((value) => value.startsWith("hooks.UserPromptSubmit=[{hooks=[{type=\"command\""))).toBe(true);
  expect(values.some((value) => value.startsWith("hooks.PostToolUse=[{hooks=[{type=\"command\""))).toBe(true);
  const state = values.find((value) => value.startsWith("hooks.state={"))!;
  const layer =
    process.platform === "win32"
      ? "C:\\\\<session-flags>\\\\config.toml"
      : "/<session-flags>/config.toml";
  for (const label of ["user_prompt_submit", "post_tool_use"])
    expect(state).toContain(`"${layer}:${label}:0:0"={trusted_hash="sha256:`);
  expect(() => codexHookOverrides("node", hook)).toThrow("absolute");
});

test("Windows hook commands are bare words so PowerShell runs them", () => {
  const spaced = join(mkdtempSync(join(tmpdir(), "codex hook ")), "Program Files");
  mkdirSync(spaced);
  const node = join(spaced, "node.exe");
  const hook = join(spaced, "codex-hook-cli.js");
  for (const path of [node, hook]) writeFileSync(path, "");
  const aliases = new Map([
    [node, "C:\\PROGRA~1\\nodejs\\node.exe"],
    [hook, "C:\\repo\\test\\CODEX-~1.TS"],
  ]);
  const value = codexHookOverrides(node, hook, "win32", (path) => aliases.get(path)!)[1];
  expect(value).toContain(
    'command="C:\\\\PROGRA~1\\\\nodejs\\\\node.exe C:\\\\repo\\\\test\\\\CODEX-~1.TS"',
  );
  expect(() =>
    codexHookOverrides(node, hook, "win32", () => "C:\\Program Files\\x"),
  ).toThrow("no 8.3 alias");
});

test("hook-origin context matches only Codex's tagged developer message", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-context-"));
  const thread = "019abcde-1234-5678-abcd-0123456789ab";
  const path = join(root, `rollout-${thread}.jsonl`);
  const message = { id: "m1", recipient: "actor", kind: "question", body: "Do it" };
  const text = CODEX_PEER_PREFIX + JSON.stringify({ message, leaseToken: "t", leaseUntil: 1, attempt: 1 });
  const meta = { type: "session_meta", payload: { id: thread, cwd: root } };
  const item = (role: string, kinds: string[]) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    },
  });
  const check = () =>
    hasCodexContext(path, thread, root, message, new AbortController().signal, "hook");
  const write = (...rows: unknown[]) =>
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  write(meta, item("user", ["hooks.additional_context"]));
  expect(await check()).toBe(false);
  write(meta, item("developer", []));
  expect(await check()).toBe(false);
  write(meta, item("developer", ["hooks.additional_context"]));
  expect(await check()).toBe(true);
});
