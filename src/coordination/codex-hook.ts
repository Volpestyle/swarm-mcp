import { CoordinationClient } from "./ipc";
import { RuntimeDelivery } from "./runtime-delivery";
import { CODEX_PEER_PREFIX, hasCodexContext } from "./codex-context";

/** Launcher-bound hooks for an interactive Codex session. Hook output carries
 * leased context, never an implicit processing acknowledgment. Codex assigns
 * its thread ID after launch, so the binding is the rollout itself: the hook
 * only admits into a transcript named for the hook's own session. */
export async function codexHook(
  input: {
    session_id: string;
    hook_event_name: string;
    transcript_path?: string;
    cwd?: string;
    /** Set by Codex only for hooks that run inside a subagent. */
    agent_id?: string;
  },
  binding: { endpoint: string; capability: string },
) {
  // A subagent's context is not the enrolled actor's; leave the message
  // pending for the main thread's next boundary (see VUH-1406 for Claude).
  if (input.agent_id) return {};
  const event = input.hook_event_name;
  if (!["UserPromptSubmit", "PostToolUse"].includes(event)) return {};
  const transcript = input.transcript_path ?? "";
  if (!input.session_id || !input.cwd)
    throw new Error("Codex hook input lacks its native session binding");
  const client = await CoordinationClient.connect(
    binding.endpoint,
    binding.capability,
  );
  try {
    const context = (await client.request({ op: "bootstrap" })) as {
      actor: string;
    };
    const boundary = event === "PostToolUse" ? "tool_complete" : "turn_start";
    let additionalContext: string | undefined;
    const delivery = new RuntimeDelivery(
      context.actor,
      (operation) => client.request(operation),
      {
        name: "codex-hooks",
        boundaries: [boundary],
        observe: () => ({
          state: boundary === "tool_complete" ? "busy" : "idle",
          evidence: `Codex ${event} callback`,
          observedAt: Date.now(),
        }),
        async deliver(lease, _boundary, signal) {
          signal.throwIfAborted();
          const alreadyPresent = await hasCodexContext(
            transcript,
            input.session_id,
            input.cwd!,
            lease.message,
            signal,
            "hook",
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
            : CODEX_PEER_PREFIX + JSON.stringify(lease);
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
