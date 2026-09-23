import { randomUUID } from "node:crypto";
import { CoordinationClient } from "./ipc";
import { RuntimeDelivery } from "./runtime-delivery";
import { CLAUDE_PEER_PREFIX, hasClaudeContext } from "./claude-context";

/** Launcher-bound hooks for an existing Claude session. Hook output carries
 * leased context, never an implicit processing acknowledgment. */
export async function claudeHook(
  input: {
    session_id: string;
    hook_event_name: string;
    transcript_path?: string;
  },
  binding: { sessionId: string; endpoint: string; capability: string },
) {
  if (input.session_id !== binding.sessionId)
    throw new Error("Claude hook session does not match launcher binding");
  const event = input.hook_event_name;
  if (
    !["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse"].includes(
      event,
    )
  )
    return {};
  const client = await CoordinationClient.connect(
    binding.endpoint,
    binding.capability,
  );
  try {
    const context = (await client.request({ op: "bootstrap" })) as {
      actor: string;
    };
    if (event === "SessionEnd") {
      await client.request({
        op: "command",
        command: {
          id: randomUUID(),
          type: "session.close",
          payload: {},
        },
      });
      return {};
    }
    if (event === "SessionStart") return {};
    const boundary = event === "PostToolUse" ? "tool_complete" : "turn_start";
    let additionalContext: string | undefined;
    const delivery = new RuntimeDelivery(
      context.actor,
      (operation) => client.request(operation),
      {
        name: "claude-code-hooks",
        boundaries: [boundary],
        observe: () => ({
          state: boundary === "tool_complete" ? "busy" : "idle",
          evidence: `Claude ${event} callback`,
          observedAt: Date.now(),
        }),
        async deliver(lease, _boundary, signal) {
          signal.throwIfAborted();
          const alreadyPresent = await hasClaudeContext(
            input.transcript_path ?? "",
            input.session_id,
            lease.message,
            signal,
          );
          signal.throwIfAborted();
          additionalContext = alreadyPresent
            ? "Swarm delivery lease renewed for a peer message already in this context. Use this token only after processing that message; do not repeat completed effects.\n" +
              JSON.stringify({
                messageId: lease.message.id,
                leaseToken: lease.leaseToken,
                leaseUntil: lease.leaseUntil,
                attempt: lease.attempt,
              })
            : CLAUDE_PEER_PREFIX + JSON.stringify(lease);
          return "admitted";
        },
      },
    );
    await delivery.atBoundary(boundary);
    return additionalContext
      ? { hookSpecificOutput: { hookEventName: event, additionalContext } }
      : {};
  } finally {
    client.close();
  }
}
