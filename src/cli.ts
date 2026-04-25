import { runInit } from "./init";
import { run as runCmd, SUBCOMMANDS } from "./cmd";

const [, , subcommand, ...rest] = process.argv;

async function main() {
  if (!subcommand || subcommand === "serve") {
    // Default: start the MCP server over stdio. Importing the server module
    // has the side effect of opening the SQLite file and booting the server.
    await import("./index");
    return;
  }

  if (subcommand === "init") {
    await runInit(rest);
    return;
  }

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printHelp();
    return;
  }

  if (SUBCOMMANDS.includes(subcommand)) {
    await runCmd(subcommand, rest);
    return;
  }

  console.error(`Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`swarm-mcp — MCP server for multi-agent coordination

Usage:
  swarm-mcp             Start the MCP server over stdio (default).
  swarm-mcp serve       Same as above.
  swarm-mcp init        Install MCP config + the swarm-mcp skill into the current directory.
  swarm-mcp help        Show this message.

Init flags:
  --force               Overwrite existing skill files.
  --dir <path>          Install into <path> instead of the current directory.
  --no-skills           Skip copying the skill.

Inspect / interact with a live swarm (operates on ~/.swarm-mcp/swarm.db):
  swarm-mcp inspect [--scope <path>] [--json]
      One-shot dump of instances, tasks, context, kv, and recent messages.
  swarm-mcp instances [--scope <path>] [--json]
  swarm-mcp messages  [--scope <path>] [--to <who>] [--from <who>] [--limit N]
      Peeks; does not mark messages read.
  swarm-mcp tasks     [--scope <path>] [--status <status>] [--json]
  swarm-mcp context   [--scope <path>] [--json]
  swarm-mcp kv list   [--scope <path>] [--prefix <p>] [--json]
  swarm-mcp kv get <key> [--scope <path>] [--json]

Write commands (require identity):
  swarm-mcp send --to <who> <content...> [--as <who>]
  swarm-mcp broadcast <content...>       [--as <who>]
  swarm-mcp kv set <key> <value>         [--as <who>]
  swarm-mcp kv append <key> <json-value> [--as <who>]
  swarm-mcp kv del <key>                 [--as <who>]
  swarm-mcp lock <file>   [--note "..."] [--as <who>]
  swarm-mcp unlock <file>                [--as <who>]
  swarm-mcp ui list      [--scope <path>] [--status <status>] [--limit N] [--json]
  swarm-mcp ui get <id>  [--json]
  swarm-mcp ui spawn <cwd> [--harness <claude|codex|opencode>] [--role <role>] [--label <tokens>] [--scope <path>] [--wait <seconds>] [--json]
  swarm-mcp ui prompt --target <node|instance|pty> <content...> [--no-enter] [--scope <path>] [--wait <seconds>] [--json]
  swarm-mcp ui move --target <node|instance|pty> --x <n> --y <n> [--scope <path>] [--wait <seconds>] [--json]
  swarm-mcp ui organize [--kind grid] [--scope <path>] [--wait <seconds>] [--json]

Identity:
  <who> is a UUID, UUID prefix, or a unique substring of an instance label.
  Identity resolves from --as, then $SWARM_MCP_INSTANCE_ID, then the sole
  live instance in scope (if exactly one). Scope defaults to the git root of
  the current directory; pass --scope to override.
`);
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err);
  process.exit(1);
});
