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
paths. Each profile uses an isolated coordinator database; startup rejects
databases belonging to other applications.
