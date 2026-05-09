export const SUBCOMMANDS = [
  "register",
  "deregister",
  "whoami",
  "instances",
  "list-instances",
  "messages",
  "tasks",
  "request-task",
  "dispatch",
  "context",
  "kv",
  "send",
  "broadcast",
  "prompt-peer",
  "lock",
  "unlock",
  "inspect",
  "cleanup",
  "ui",
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}
