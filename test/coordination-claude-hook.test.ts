import { expect, test } from "bun:test";
import { claudeHook } from "../src/coordination/claude-hook";

test("Claude hooks reject another native session before using its capability", async () => {
  for (const hook_event_name of [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PostToolUse",
  ])
    await expect(
      claudeHook(
        { session_id: "other", hook_event_name },
        {
          sessionId: "bound",
          endpoint: "must-not-connect",
          capability: "must-not-use",
        },
      ),
    ).rejects.toThrow("Claude hook session does not match launcher binding");
});

test("unsupported Claude events cannot claim a delivery boundary", async () => {
  expect(
    await claudeHook(
      { session_id: "bound", hook_event_name: "Notification" },
      {
        sessionId: "bound",
        endpoint: "must-not-connect",
        capability: "must-not-use",
      },
    ),
  ).toEqual({});
});
