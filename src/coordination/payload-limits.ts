import { CoordinationError } from "./errors";

export const COMMAND_RESULT_BYTES = 64 * 1024;
export const EVENT_PAYLOAD_BYTES = 64 * 1024;
export const EVENT_PAGE_BYTES = 96 * 1024;
export const MCP_DATA_BYTES = 128 * 1024;

export function boundedJson(
  value: unknown,
  bytes: number,
  subject: string,
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > bytes)
    throw new CoordinationError(
      "payload_too_large",
      `${subject} exceeds ${bytes} bytes; use smaller pages or artifact references`,
    );
  return serialized;
}
