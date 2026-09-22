export class CoordinationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoordinationError";
  }
}

export function requireText(
  value: unknown,
  name: string,
  max = 256,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw new CoordinationError(
      "invalid_input",
      `${name} must be nonempty text of at most ${max} characters`,
    );
  }
}
