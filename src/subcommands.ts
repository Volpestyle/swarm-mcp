export const SUBCOMMANDS = [
  "instances",
  "messages",
  "tasks",
  "context",
  "kv",
  "send",
  "broadcast",
  "lock",
  "unlock",
  "inspect",
  "ui",
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}
