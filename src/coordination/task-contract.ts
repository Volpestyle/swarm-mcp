import { CoordinationError, requireText } from "./errors";

/** Work intent. Scope and current owner come from authenticated task/attempt rows. */
export type TaskContract = {
  objective: string;
  worktree: string;
  acceptanceCriteria: string[];
  expectedArtifacts: string[];
  constraints: string[];
  /** Immutable, scope-visible instruction artifacts, in reading order. */
  instructions?: string[];
};

export function validateTaskContract(input: TaskContract): TaskContract {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CoordinationError(
      "invalid_input",
      "Task contract must be an object",
    );
  requireText(input.objective, "objective", 4096);
  requireText(input.worktree, "worktree", 4096);
  const list = (value: string[], name: string, required = false) => {
    if (
      !Array.isArray(value) ||
      value.length > 20 ||
      (required && !value.length)
    )
      throw new CoordinationError(
        "invalid_input",
        `${name} must contain ${required ? "1" : "0"}..20 entries`,
      );
    for (const entry of value) requireText(entry, name, 1024);
    return [...value];
  };
  const contract = {
    objective: input.objective,
    worktree: input.worktree,
    acceptanceCriteria: list(
      input.acceptanceCriteria,
      "acceptanceCriteria",
      true,
    ),
    expectedArtifacts: list(input.expectedArtifacts, "expectedArtifacts"),
    constraints: list(input.constraints, "constraints"),
    ...(input.instructions === undefined ? {} : {
      instructions: list(input.instructions, "instructions").map((uri) => {
        if (!/^swarm:\/\/artifacts\/[a-zA-Z0-9-]{1,128}$/.test(uri))
          throw new CoordinationError("invalid_input", "Instructions must be Swarm artifact URIs");
        return uri;
      }),
    }),
  };
  if (Buffer.byteLength(JSON.stringify(contract)) > 8192)
    throw new CoordinationError(
      "payload_too_large",
      "Task contract exceeds 8 KiB; link supporting artifacts",
    );
  return contract;
}
