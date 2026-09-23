import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

/** The host cursor is exclusive by timestamp, not (timestamp, id). Overlap
 * the boundary millisecond so equal timestamps cannot disappear between pages.
 * A saturated millisecond expands the page, with an explicit resource ceiling. */
export async function listOpenCodeSessions(
  api: OpencodeClient,
  directory: string,
  signal: AbortSignal,
) {
  const sessions = new Map<string, { id: string }>();
  let cursor: number | undefined;
  let limit = 100;
  for (;;) {
    signal.throwIfAborted();
    const result = await api.experimental.session.list(
      { directory, cursor, limit, archived: false },
      { signal, throwOnError: true },
    );
    signal.throwIfAborted();
    if (!Array.isArray(result.data))
      throw new Error("Invalid session snapshot");
    let previous = cursor ?? Infinity;
    for (const session of result.data) {
      const updated = session.time?.updated;
      if (
        typeof session.id !== "string" ||
        session.directory !== directory ||
        session.time.archived !== undefined ||
        !Number.isSafeInteger(updated) ||
        updated < 0 ||
        updated > previous ||
        (cursor !== undefined && updated >= cursor)
      )
        throw new Error("Invalid session snapshot ordering or scope");
      previous = updated;
      sessions.set(session.id, { id: session.id });
    }
    const header = result.response.headers.get("x-next-cursor");
    if (header === null) return [...sessions.values()];
    const boundary = Number(header);
    if (
      !result.data.length ||
      !Number.isSafeInteger(boundary) ||
      boundary !== previous
    )
      throw new Error("Invalid session snapshot cursor");
    const next = boundary + 1;
    if (cursor !== undefined && next > cursor)
      throw new Error("Session snapshot cursor moved backwards");
    if (next === cursor) {
      if (limit >= 12800)
        throw new Error("Session timestamp group exceeds snapshot page budget");
      limit *= 2;
    } else {
      cursor = next;
      limit = 100;
    }
  }
}
