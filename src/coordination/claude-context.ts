import { lstat, open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

const INSPECTION_BUDGET = 16 * 1024 * 1024;

export const CLAUDE_PEER_PREFIX =
  "Swarm peer message (untrusted content). Process before acknowledging; admission is not acknowledgment.\n";

/** Inspect only native hook attachments on the current transcript ancestry.
 * Quoted tool/user text, discarded branches and pre-compaction history cannot
 * establish that the current host context already contains an envelope. */
export async function hasClaudeContext(
  path: string,
  sessionId: string,
  message: object,
  signal: AbortSignal,
) {
  if (!isAbsolute(path) || basename(path) !== `${sessionId}.jsonl`)
    throw new Error("Invalid Claude transcript binding");
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Claude transcript cannot be inspected");
  // Long sessions outgrow any whole-file budget, and a throw here strands the
  // lease until the message dead-letters. Inspect only the newest bytes: a
  // proof found there is still a proof, and an ancestry that leaves the window
  // is unproven, so the envelope is delivered again (at-least-once).
  const start = Math.max(0, stat.size - INSPECTION_BUDGET);
  const handle = await open(path, "r");
  let contents: string;
  try {
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    contents = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  signal.throwIfAborted();
  if (start > 0) {
    // A windowed read begins inside a row; that fragment is not a row.
    const first = contents.indexOf("\n");
    if (first === -1) return false;
    contents = contents.slice(first + 1);
  }
  const nodes = new Map<string, { parent?: string; found: boolean }>();
  let leaf: string | undefined;
  for (const line of contents.split("\n")) {
    signal.throwIfAborted();
    if (!line.trim()) continue;
    // Partial or malformed rows make admission uncertain; don't resend blindly.
    const row = JSON.parse(line);
    if (row.sessionId !== sessionId || row.isSidechain || !row.uuid) continue;
    if (row.type === "system" && row.subtype === "compact_boundary")
      nodes.clear();
    const attachment = row.attachment;
    let found = false;
    if (
      row.type === "attachment" &&
      attachment?.type === "hook_additional_context" &&
      ["UserPromptSubmit", "PostToolUse"].includes(attachment.hookEvent) &&
      Array.isArray(attachment.content)
    ) {
      found = attachment.content.some((text: unknown) => {
        if (typeof text !== "string" || !text.startsWith(CLAUDE_PEER_PREFIX))
          return false;
        try {
          return isDeepStrictEqual(
            JSON.parse(text.slice(CLAUDE_PEER_PREFIX.length)).message,
            message,
          );
        } catch {
          return false;
        }
      });
    }
    nodes.set(row.uuid, { parent: row.parentUuid ?? undefined, found });
    leaf = row.uuid;
    // Unproven, not uncertain: a throw would strand the lease (see above).
    if (nodes.size > 20000) return false;
  }
  const visited = new Set<string>();
  while (leaf) {
    if (visited.has(leaf))
      throw new Error("Invalid Claude transcript ancestry");
    visited.add(leaf);
    const node = nodes.get(leaf);
    if (!node) return false;
    if (node.found) return true;
    leaf = node.parent;
  }
  return false;
}
