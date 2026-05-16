import { runInit } from "./init";
import { runInstall } from "./install";
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

  if (subcommand === "install") {
    runInstall(rest);
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
  swarm-mcp                                 Start the MCP server over stdio (default).
  swarm-mcp <command> [flags]               Run a CLI command (see groups below).
  swarm-mcp <command> --help                Show help for the command, if available.

Setup
  install [--host <name>[,…]] [--no-skill] [--force] [--dry-run] [--json]
      Wire swarm into your coding-agent hosts. Hosts: claude-code, codex,
      opencode, cursor, all. Writes the host's MCP config and symlinks the
      bundled skill into its skill root. Auto-detects installed hosts if --host
      is omitted. Run 'swarm-mcp install --help' for details.
  init [--dir <path>] [--force] [--no-skills]
      Project-local setup: write .mcp.json and copy the skill into
      .claude/skills/swarm-mcp under <dir> (defaults to cwd).
  doctor [--scope <path>] [--json]
      Health report: binary, db, scope, instances, skill/plugin install, env
      knobs. Exits non-zero on FAIL.
  roles [--scope <path>] [--json]
      List role aliases (worker/gateway plugin modes; planner / implementer /
      reviewer / researcher / generalist routing roles), how each is invoked,
      and what the current session resolves to.

Identity
  register [directory] [--label <tokens>] [--scope <path>] [--file-root <path>]
           [--lease-seconds N] [--adopt-instance-id <id>] [--json]
  bootstrap [directory] [--adopt-instance-id <id>] [--scope <path>] [--json]
  deregister [--as <who>] [--scope <path>] [--json]
  whoami [--as <who>] [--scope <path>] [--json]

Peers
  instances        [--scope <path>] [--json]              (alias: list-instances)
  inspect          [--scope <path>] [--json]
      One-shot dump of instances, tasks, locks, kv, and recent messages.

Tasks
  tasks            [--scope <path>] [--status <status>] [--json]
  request-task <type> <title...> [--description <text>] [--file <path>]
               [--priority N] [--idempotency-key <key>] [--as <who>] [--json]
  claim <task-id> [--force] [--as <who>] [--json]
      Claim an open or pre-assigned task and transition it to in_progress.
      --force ignores the unread-message gate.
  update-task <task-id> --status <done|failed|cancelled> [--note <result>]
              [--as <who>] [--json]
      Move a task to a terminal status; auto-releases this instance's locks
      on the task's listed files.
  dispatch <title...> [--message <text>] [--type <type>] [--role <role>]
           [--spawner <herdr|swarm-ui>] [--harness <harness>]
           [--idempotency-key <key>] [--no-spawn] [--force-spawn]
           [--wait <seconds>] [--wait-for-completion <seconds>]
           [--as <who>] [--json]

Messaging
  messages    [--scope <path>] [--to <who>] [--from <who>] [--limit N]
      Peeks; does not mark messages read.
  send --to <who> <content...> [--as <who>]
  broadcast <content...> [--as <who>]
  prompt-peer --to <who> --message <text> [--task <id>] [--force] [--no-nudge]
              [--as <who>]
  resolve-workspace-handle <handle> [--backend herdr] [--kind pane]
                           [--scope <path>] [--as <who>] [--json]

Locks
  locks   [--scope <path>] [--json]
  lock <file>   [--note "..."] [--exclusive] [--task <task-id>] [--as <who>]
      Pass --task to associate the lock with a task; terminal update-task
      releases all locks under that task_id.
  unlock <file>                [--as <who>]

KV
  kv list   [--scope <path>] [--prefix <p>] [--json]
  kv get <key> [--scope <path>] [--json]
  kv set <key> <value>         [--as <who>]
  kv append <key> <json-value> [--as <who>]
  kv del <key>                 [--as <who>]

Maintenance
  cleanup [--scope <path>] [--dry-run] [--json]
      Run retention cleanup for offline instances, old rows, and orphaned KV.

Spawner UI (swarm-ui control plane)
  ui list      [--scope <path>] [--status <status>] [--limit N] [--json]
  ui get <id>  [--json]
  ui spawn <cwd> [--harness <name>] [--role <role>] [--label <tokens>]
                 [--scope <path>] [--wait <seconds>] [--json]
  ui prompt --target <node|instance|pty> <content...> [--no-enter]
            [--scope <path>] [--wait <seconds>] [--json]
  ui move --target <node|instance|pty> --x <n> --y <n>
          [--scope <path>] [--wait <seconds>] [--json]
  ui organize [--kind grid] [--scope <path>] [--wait <seconds>] [--json]

Identity resolution:
  <who> is a UUID, UUID prefix, or a unique substring of an instance label.
  Identity resolves from --as, then $SWARM_MCP_INSTANCE_ID, then the sole live
  instance in scope (if exactly one). Scope defaults to $SWARM_MCP_SCOPE, then
  the git root of the current directory; pass --scope to override.
`);
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err);
  process.exit(1);
});
