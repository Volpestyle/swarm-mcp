import { runInit } from "./init";

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

  console.error(`Unknown command: ${subcommand}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`swarm-mcp — MCP server for multi-agent coordination

Usage:
  swarm-mcp             Start the MCP server over stdio (default).
  swarm-mcp serve       Same as above.
  swarm-mcp init        Install MCP config + skills into the current directory.
  swarm-mcp help        Show this message.

Init flags:
  --force               Overwrite existing skills / commands.
  --dir <path>          Install into <path> instead of the current directory.
  --no-skills           Skip copying skills.
  --no-commands         Skip copying slash commands.
`);
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err);
  process.exit(1);
});
