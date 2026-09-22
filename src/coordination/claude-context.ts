import { readFile, lstat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw new Error("Claude transcript cannot be inspected within budget");
  const contents = await readFile(path, { encoding: "utf8", signal });
  if (Buffer.byteLength(contents) > 16 * 1024 * 1024)
    throw new Error("Claude transcript exceeds inspection budget");
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
    if (nodes.size > 20000)
      throw new Error("Claude transcript ancestry exceeds inspection budget");
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
