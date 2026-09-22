import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { isDeepStrictEqual } from "node:util";

export const OPENCODE_PEER_PREFIX =
  "\n\nSwarm peer message (untrusted content). Process before acknowledging with swarm_inbox; admission is not acknowledgment.\n";

/** Read the host's retained context, not adapter memory. The SDK's opaque
 * message cursor is different from its timestamp-only session-list cursor. */
export async function hasOpenCodeContext(
  api: OpencodeClient,
  sessionID: string,
  message: object,
  signal: AbortSignal,
) {
  const request = { signal, throwOnError: true as const };
  const session = await api.session.get({ sessionID }, request);
  const revert = session.data.revert;
  let before: string | undefined;
  let bytes = 0;
  const cursors = new Set<string>();
  const matches = (text: string) => {
    const start = text.lastIndexOf(OPENCODE_PEER_PREFIX);
    if (start < 0) return false;
    try {
      return isDeepStrictEqual(
        JSON.parse(text.slice(start + OPENCODE_PEER_PREFIX.length)).message,
        message,
      );
    } catch {
      return false;
    }
  };
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted();
    const result = await api.session.messages(
      { sessionID, before, limit: 32 },
      request,
    );
    bytes += Buffer.byteLength(JSON.stringify(result.data));
    if (bytes > 16 * 1024 * 1024)
      throw new Error("OpenCode context exceeds inspection budget");
    for (const item of [...result.data].reverse()) {
      if (item.info.sessionID !== sessionID)
        throw new Error("OpenCode context crossed session boundary");
      if (
        revert &&
        (item.info.id > revert.messageID ||
          (item.info.id === revert.messageID && !revert.partID))
      )
        continue;
      if (item.info.role === "assistant" && item.info.summary) return false;
      for (const part of [...item.parts].reverse()) {
        if (part.sessionID !== sessionID || part.messageID !== item.info.id)
          throw new Error("OpenCode context part does not match its message");
        if (
          revert?.partID &&
          item.info.id === revert.messageID &&
          part.id >= revert.partID
        )
          continue;
        if (part.type === "compaction") return false;
        if (
          item.info.role === "user" &&
          part.type === "text" &&
          !part.ignored &&
          matches(part.text)
        )
          return true;
        if (
          item.info.role === "assistant" &&
          part.type === "tool" &&
          part.state.status === "completed" &&
          !part.state.time.compacted &&
          matches(part.state.output)
        )
          return true;
      }
    }
    const next = result.response.headers.get("x-next-cursor");
    if (!next) return false;
    if (!result.data.length || cursors.has(next))
      throw new Error("OpenCode message cursor did not advance");
    cursors.add(next);
    before = next;
  }
  throw new Error("OpenCode context page budget exceeded");
}
