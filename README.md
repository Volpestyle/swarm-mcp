# swarm-mcp

Durable local coordination between independent coding-agent sessions: acknowledged
messages, fenced task ownership, shared context and retained evidence. Native
runtimes own their children; Swarm coordinates across session boundaries.

## Get started

The candidate uses one Node owner per isolated database/profile and nine MCP
tools. Trusted launchers enroll sessions and supply capabilities; MCP adapters do
not open the database or select their own identity.

- [Install and enroll](docs/install-skill.md)
- [Swarm API](docs/api.md) and [consumer skill](skills/swarm-mcp/SKILL.md)
- [Host support and limitations](docs/runtime-host-support.md)
- [Embed in a runtime or dispatch through Herdr](docs/runtime-embedding.md)
- [Storage limits and offline maintenance](docs/storage-maintenance.md)
- [Migration and rollback](docs/migration-cutover.md)

This is a local release candidate. Building or installing it does not migrate an
existing swarm or switch live host configuration.

## Boundaries

![Coordination boundaries](docs/diagrams/coordination.png)

[Diagram source](docs/diagrams/coordination.mmd).

Swarm owns durable acceptance, acknowledgment, attempts, reservations and evidence.
Host adapters own safe context delivery; workspace providers own execution.
Trackers retain human-facing work. A successful send does not prove model
processing, and a lease cannot guarantee exactly-once external side effects.

Automatic delivery varies by host. File reservations are cooperative. One local
OS user/profile is the trust boundary; this is not a distributed or hostile
multi-tenant service. See the [architecture decision](docs/coordination-architecture.md).

## Entrypoints

`swarm-mcp` and `swarm-coordinator-mcp` serve the same Swarm API. Both require
the endpoint and session capability supplied by a trusted runtime launcher.
See [runtime embedding](docs/runtime-embedding.md) for enrollment and launch options.

Offline migration commands preserve historical data without importing live
ownership. See [migration](docs/migration-cutover.md) and the
[application boundary decision](docs/coordination-architecture.md#application-boundary).

## Development

```sh
bun install --frozen-lockfile
bun run check
```

The focused coordination gate also measures actual 32-agent MCP context:

```sh
python3 -m pip install tiktoken==0.12.0
PYTHON=python3 bun scripts/verify-coordination.ts
npm run verify:package
```

See [verification](docs/coordination-verification.md),
[benchmark evidence](docs/coordination-benchmarks.md), and [packaging](docs/release-packaging.md).

[MIT license](LICENSE)
