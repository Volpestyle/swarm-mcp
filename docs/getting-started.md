# Getting started

Build and validate the checkout:

```sh
bun install --frozen-lockfile
bun run check
```

Use [runtime embedding](runtime-embedding.md) to create an isolated profile,
enroll the native session, and supply its endpoint and capability to the MCP
adapter. `swarm-mcp` and `swarm-coordinator-mcp` expose the same nine tools.
Install the [consumer skill](install-skill.md) and begin with `swarm_sync`.

[Host support](runtime-host-support.md) lists verified lifecycle and delivery
paths. [Migration](migration-cutover.md) imports existing data into a fresh
profile; startup never converts a database implicitly.
