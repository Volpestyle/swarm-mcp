import { runInit } from "./init";
import { isSubcommand } from "./subcommands";

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

  if (isSubcommand(subcommand)) {
    if (rest.includes("--help") || rest.includes("-h")) {
      printHelp();
      return;
    }
    const { run: runCmd } = await import("./cmd");
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
  swarm-mcp init        Install MCP config + bundled skills into the current directory.
  swarm-mcp help        Show this message.

Init flags:
  --force               Overwrite existing skill files.
  --dir <path>          Install into <path> instead of the current directory.
  --no-skills           Skip copying skills.

Inspect / interact with a live swarm (operates on ~/.swarm-mcp/swarm.db):
  swarm-mcp register [directory] [--label <tokens>] [--scope <path>] [--file-root <path>] [--lease-seconds N] [--adopt-instance-id <id>] [--json]
  swarm-mcp bootstrap [directory] [--adopt-instance-id <id>] [--scope <path>] [--json]
  swarm-mcp deregister [--as <who>] [--scope <path>] [--json]
  swarm-mcp whoami [--as <who>] [--scope <path>] [--json]
  swarm-mcp inspect [--scope <path>] [--json]
      One-shot dump of instances, tasks, locks, kv, and recent messages.
  swarm-mcp doctor [--scope <path>] [--json]
      Health report: binary, db, scope, instances, skill/plugin install, env knobs. Exits non-zero on FAIL.
  swarm-mcp cleanup [--scope <path>] [--dry-run] [--json]
      Run retention cleanup for offline instances, old rows, and orphaned KV.
  swarm-mcp instances [--scope <path>] [--json]
  swarm-mcp list-instances [--scope <path>] [--json]
  swarm-mcp messages  [--scope <path>] [--to <who>] [--from <who>] [--limit N]
      Peeks; does not mark messages read.
  swarm-mcp tasks     [--scope <path>] [--status <status>] [--json]
  swarm-mcp locks     [--scope <path>] [--json]
  swarm-mcp kv list   [--scope <path>] [--prefix <p>] [--json]
  swarm-mcp kv get <key> [--scope <path>] [--json]

Write commands (require identity):
  swarm-mcp request-task <type> <title...> [--description <text>] [--file <path>] [--priority N] [--idempotency-key <key>] [--as <who>] [--json]
  swarm-mcp claim <task-id> [--force] [--as <who>] [--json]
      Claim an open or pre-assigned task and transition it to in_progress.
      --force ignores the unread-message gate (use only when intentionally claiming despite unread messages).
  swarm-mcp update-task <task-id> --status <done|failed|cancelled> [--note <result>] [--as <who>] [--json]
      Move a claimed/in_progress task to a terminal status. Auto-releases this instance's locks on the task's listed files.
  swarm-mcp dispatch <title...> [--message <text>] [--type <type>] [--role <role>] [--spawner <herdr|swarm-ui>] [--harness <harness>] [--idempotency-key <key>] [--no-spawn] [--force-spawn] [--wait <seconds>] [--wait-for-completion <seconds>] [--as <who>] [--json]
  swarm-mcp send --to <who> <content...> [--as <who>]
  swarm-mcp prompt-peer --to <who> --message <text> [--task <id>] [--force] [--no-nudge] [--as <who>]
  swarm-mcp resolve-workspace-handle <handle> [--backend herdr] [--kind pane] [--scope <path>] [--as <who>] [--json]
  swarm-mcp broadcast <content...>       [--as <who>]
  swarm-mcp kv set <key> <value>         [--as <who>]
  swarm-mcp kv append <key> <json-value> [--as <who>]
  swarm-mcp kv del <key>                 [--as <who>]
  swarm-mcp lock <file>   [--note "..."] [--exclusive] [--task <task-id>] [--as <who>]
      Pass --task to associate the lock with a task; terminal update-task releases all locks under that task_id.
  swarm-mcp unlock <file>                [--as <who>]
  swarm-mcp ui list      [--scope <path>] [--status <status>] [--limit N] [--json]
  swarm-mcp ui get <id>  [--json]
  swarm-mcp ui spawn <cwd> [--harness <name>] [--role <role>] [--label <tokens>] [--scope <path>] [--wait <seconds>] [--json]
  swarm-mcp ui prompt --target <node|instance|pty> <content...> [--no-enter] [--scope <path>] [--wait <seconds>] [--json]
  swarm-mcp ui move --target <node|instance|pty> --x <n> --y <n> [--scope <path>] [--wait <seconds>] [--json]
  swarm-mcp ui organize [--kind grid] [--scope <path>] [--wait <seconds>] [--json]

Identity:
  <who> is a UUID, UUID prefix, or a unique substring of an instance label.
  Identity resolves from --as, then $SWARM_MCP_INSTANCE_ID, then the sole
  live instance in scope (if exactly one). Scope defaults to $SWARM_MCP_SCOPE,
  then the git root of the current directory; pass --scope to override.
`);
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err);
  process.exit(1);
});
