# swarm-mcp

Local coordination for coding agents. One coordinator process per profile owns
the SQLite state: durable acknowledged inboxes, fenced task attempts, shared
context, retained evidence and an ordered event log. Each agent session reaches
it through a thin stdio MCP adapter that exposes nine tools, and trusted
runtime launchers for Claude Code, OpenCode and Codex enroll sessions and
deliver messages at safe turn boundaries. Nothing leaves the machine.

Version `2.0.0-rc.1` is on `main` (PR #9, 2026-09-23) and passes the full
verification gate on hosted Windows and Ubuntu runners. It is not yet published
to npm; build it from this checkout.

[Documentation index](docs/README.md) · [GitHub](https://github.com/Volpestyle/swarm-mcp)

## Quick start

Requirements: Node 22, Bun 1.3.11, Python 3.12 (tests only), Windows or Linux.

```powershell
bun install --frozen-lockfile
bun run build
npm run verify:package
```

Then follow [installation](docs/installation.md): install the packaged skill,
wire your host's launcher, and run the doctor to confirm the owner, adapter and
skill agree:

```powershell
node dist/coordination/client-cli.js doctor
```

## How it works

| Part | Role |
| --- | --- |
| Coordinator owner (`dist/coordination/owner-cli.js`) | One Node process per profile. Serializes writes to `coordination.db`, commits state, events and receipts together, and serves an OS-local IPC endpoint (named pipe on Windows, Unix socket elsewhere). Started on demand by a launcher; never two accepted writers. |
| MCP adapter (`dist/coordination/mcp-cli.js`) | Per-session stdio server. Opens no database and cannot choose an actor or scope; it forwards authorized commands to the owner and serves resources and subscriptions. Speaks MCP 2026-07-28 with tested legacy protocol support. |
| Runtime launchers | Host-specific: Claude Code hook and MCP binding, OpenCode plugin, Codex resume path. They create private launcher state, enroll the session with a resume token, and deliver leased inbox messages at safe boundaries. |
| Packaged skill (`skills/swarm-mcp`) | The workflow agents load: sync, own and hand off work, acknowledge deliveries, record evidence. Its `swarm-coordination/1` contract stamp is checked at startup. |

Read [architecture](docs/architecture.md) for the decision record and
guarantees, and [durable inboxes](docs/durable-inboxes.md),
[session and task ownership](docs/session-and-task-ownership.md) and
[worktree reservations](docs/worktree-reservations.md) for the contracts.

## Tools

| Tool | Purpose |
| --- | --- |
| `swarm_sync` | Bootstrap or resume from an event cursor; optional bounded wait |
| `swarm_find` | Page peers and tasks, or read one task with contract, owner and result |
| `swarm_assign` | Persist a task contract and dependencies; returns a durable task ID |
| `swarm_task` | Claim with `expectedVersion`; renew, progress, finish, cancel, retry, recover with `attemptId` and `fence` |
| `swarm_send` | Typed question, blocker, decision request or completion notice on a thread |
| `swarm_inbox` | Fetch a delivery lease; acknowledge processing or reject with a reason |
| `swarm_wait` | Resume waiting on an existing task; timeout never cancels it |
| `swarm_context` | Read, compare-and-set, append or tombstone small shared values |
| `swarm_evidence` | Capture files or record results, decisions and annotations with provenance |

Every mutation carries a stable `commandId`; retrying with the same ID and
payload returns the same receipt. Reading a message is not acknowledgment.
Full semantics, budgets and resources: [compact API](docs/compact-api.md).

## Host support

| Host | Verified | Limitation |
| --- | --- | --- |
| OpenCode 1.4.3 | Installed-host lifecycle, autonomous idle-turn delivery, explicit ack, lease renewal | Delivery after a killed host and very large histories unproven |
| Claude Code 2.1.278 | Launcher hook and MCP binding, delivery at turn start and post-tool, native ack, forced-kill resume | Delivers only at native boundaries; no idle wake |
| Codex 0.155.1 | Native MCP isolation, existing-thread resume, lifecycle observation | Initial enrollment and automatic delivery unverified; degraded |
| Hermes | In-process lifecycle code, 23 Python lifecycle tests | No installed host verified |

Details and evidence: [runtime host support](docs/runtime-host-support.md).

## Operations

- **Diagnostics:** `client-cli.js doctor` and `swarm_sync` report owner and
  client build, API, schema and skill contract. See
  [startup compatibility](docs/startup-compatibility.md) and
  [coordination diagnostics](docs/coordination-diagnostics.md).
- **Migrating a legacy profile:** `migration-cli.js backup | verify | restore |
  import` moves a legacy `swarm.db` onto a new coordinator profile reversibly.
  See [migration and cutover](docs/migration-cutover.md).
- **Packaging:** `npm run verify:package` checks the production allowlist. See
  [package boundary](docs/packaging.md).

## Verification

```powershell
bun scripts/verify-coordination.ts
```

Runs typecheck, build, the Bun test suite (175 tests, 48 files) and the Python
integration tests, and refuses a result if the source changed during the run.
The same gate runs in CI on `ubuntu-latest` and `windows-latest` for every pull
request. Retained evidence lives under `docs/verification/`; see
[coordination verification](docs/coordination-verification.md) and
[benchmarks](docs/coordination-benchmarks.md).

## Legacy interface

The original stdio server (`swarm-mcp` bin, `register`/`poll_messages` tools,
shared `~/.swarm-mcp/swarm.db`, herdr and swarm-ui backends, `apps/swarm-server`)
still ships in this package because existing profiles run on it. It is
documented under [docs/legacy](docs/legacy/README.md) and is retired under
Linear VUH-1360 once the live profile has moved to the coordinator. Do not point
a legacy server at a coordinator database; the packaged `swarm-legacy-guard`
refuses that.

## Development

- `bun run typecheck`, `bun test`, `bun run build`, `bun run diagrams`
- Conventions for contributors and agents: [AGENTS.md](AGENTS.md)
- Repo-internal skills: [.agents/skills](.agents/skills)

## License

[MIT](LICENSE)
