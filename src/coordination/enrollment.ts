import { timingSafeEqual } from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import { secretHash, type Enrollment } from "./sessions";
import type { CoordinationStore } from "./store";

/** Bind trusted launchers to the owner's single writer. The launcher secret is
 * never exported to an agent's environment or accepted as a session capability.
 */
export function launcherEnrollment(
  store: CoordinationStore,
  launcherSecret: string,
) {
  requireText(launcherSecret, "launcher secret", 512);
  if (launcherSecret.length < 32)
    throw new CoordinationError(
      "invalid_input",
      "Launcher secret must contain at least 32 characters of generated secret material",
    );
  const digest = Buffer.from(secretHash(launcherSecret), "hex");
  return (credential: string, input: unknown) => {
    if (!timingSafeEqual(digest, Buffer.from(secretHash(credential), "hex")))
      throw new CoordinationError(
        "forbidden",
        "Launcher enrollment requires its separate credential",
      );
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new CoordinationError(
        "invalid_input",
        "Enrollment must be an object",
      );
    const record = input as Record<string, unknown>;
    for (const field of ["scope", "agentId", "requestId", "resumeToken"])
      requireText(record[field], field, field === "resumeToken" ? 512 : 256);
    if (record.label !== undefined) requireText(record.label, "label", 1024);
    if (record.worktree !== undefined) {
      if (
        !record.worktree ||
        typeof record.worktree !== "object" ||
        Array.isArray(record.worktree)
      )
        throw new CoordinationError(
          "invalid_input",
          "Worktree must be an object",
        );
      const worktree = record.worktree as Record<string, unknown>;
      requireText(worktree.root, "worktree root", 4096);
      requireText(worktree.repository, "repository", 4096);
    }
    return store.openSession(record as Enrollment);
  };
}
