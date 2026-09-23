# ADR: one local coordination owner with native runtime integration

Status: accepted 2026-09-21 (VUH-1331); implemented and merged in PR #9, 2026-09-23.

## Decision

Use one automatically managed local coordination service per isolated database/profile. It owns SQLite mutations, the domain state machine and event wakeups. Thin stdio MCP adapters and host integrations call the same command/query interface. Prefer native runtime communication and execution for agents within the same managed tree; bridge into durable swarm coordination only when work crosses independent sessions or needs durable cross-session ownership.

Keep TypeScript and SQLite. Separate the existing desktop/mobile control plane, workspace launchers and tracker adapters from this coordination owner. The service is a local process, not a cloud dependency. It uses OS-local IPC: a Windows named pipe, or a Unix socket elsewhere. The experiment used loopback HTTP to measure the topology; it is not the production endpoint.

The April-only design could not simply be patched forward. The redesign preserves the useful final-upstream identity adoption, adapter boundaries and task contracts, and replaces destructive inbox consumption, unfenced ownership and full-swarm bootstrap dumps.

Implementation verification selected Node 22 for the Windows service owner. Bun
1.3.11 crashes natively on a duplicate named-pipe bind; Node 22.14.0 returns
`EADDRINUSE`. Bun clients are supported against that owner. The standalone
reproduction and mixed-runtime IPC checks are retained in the
[core verification record](verification/2026-09-21-core/README.md).

## Evidence and alternatives

Hardware/workload and raw results live in [the baseline evidence](verification/2026-09-21-baseline/README.md). The fixed workload is 12 ring messages per agent, 256-byte bodies, real independent Bun processes, temporary SQLite databases, and bounded observation. Module experiments exclude real host/model execution.

| Candidate | Observed behavior / operational consequence | Decision |
|---|---|---|
| Shared SQLite, existing per-process polling | At 2/8/32 agents p95 delivery 1822/1852/3398 ms. At 32: 379/384 accepted, five errors, 19 accepted messages unread at deadline. No service to operate, but every process owns writes/cleanup and polling. | Rejected as the default architecture. |
| Shared SQLite without per-operation cleanup | At 32: 376 accepted, 361 read, eight errors; p95 3218 ms. | Cleanup removal alone does not resolve this workload. Retain the lesson that cleanup should not be an incidental effect of a read. |
| Shared SQLite with lean atomic message/event transactions | At 32: 381 accepted, 372 read, nine operation errors; p95 3521 ms. Some errors are reads, not sends. | Atomicity is required for correctness but alone does not resolve contention. |
| One local writer with held notification requests | At 32: 384 accepted and read, no errors, p95 37 ms; clean repeat 36 ms. Repeat idle CPU 0.74% of one core. Adds process supervision and reconnection; one place for ordering, cleanup and backpressure. | Selected for independent sessions. |
| Native runtime with external bridge | Native runtime already owns its children, wakeups and cancellation; avoids registering every internal child as an independent swarm agent. Cannot cover unrelated hosts or durable cross-session handoffs alone. No native-runtime performance measurement is claimed here. | Preferred within a managed tree; bridge at the boundary. |

The one-second-renewal broker prototype used 16.7% idle CPU at 32 agents after warmup. Holding the wait for up to 30 seconds reduced the measured idle cost substantially. Production notifications remain pending or stream events; they do not busy-poll through model turns.

The initial held-wait sample overlapped a tokenizer installation. The clean repeat ran after installation and MCP captures completed; use the repeat for the idle budget comparison. Both delivery results are retained. RSS in the repeat is approximately 4.36 GiB across worker processes plus 184 MiB for the broker; worker RSS includes shared pages and substantial Bun runtime overhead. The prototype does not prove a large memory saving; thin production adapters are measured separately in [coordination benchmarks](coordination-benchmarks.md).

No-loss behavior in these successful samples does not prove reliability: the prototype deliberately retained destructive polling for comparability. Durable acknowledgements, restart recovery and stale-owner rejection are proven by the fault-injection gate in [coordination verification](coordination-verification.md), not by this prototype.

A network database or distributed broker does not address the demonstrated local context/ownership problems. For future multiple-machine use, commands and cursors stay transport-neutral, and authenticated remote access to a single authoritative coordinator comes first. Multi-writer replication, leader election across machines and remote file reservations are outside this release.

## Actual MCP context baseline

`scripts/measure-mcp-context.ts` drives real SDK clients and stdio servers: register, bootstrap, one ring send, one inbox poll per agent. No model inference or native host was invoked. `scripts/count-context-tokens.py` counts explicit argument JSON and response text using pinned `tiktoken==0.12.0`, `o200k_base`. Hidden host framing, model reasoning and billing are excluded.

| Agents | Explicit tool calls | Call arguments + result text tokens | Bootstrap result tokens | Schema tokens if loaded once per agent |
|---|---|---|---|---|
| 2 | 8 | 2534 | 1306 | 12084 |
| 8 | 32 | 20288 | 15440 | 48336 |
| 32 | 128 | 246300 | 226816 | 193344 |

The legacy 33-tool catalog is 6042 tokens under this explicit encoding. Host deferred discovery may avoid loading all of it, so schema multiplication is a stated scenario rather than an observed model bill. Legacy bootstrap grows with the number of peers returned to every agent. The [compact API](compact-api.md) bootstraps around the actor's assigned work, pending inbox, relevant reservations and a cursor; peer search and historical detail are explicit paginated queries.

## Ownership and delivery guarantees

- Stable actor identity survives reconnects. A session incarnation has a monotonically increasing generation and a server-issued capability tied to its profile and actor. Resume requires the capability or a trusted launcher adoption path, not a matching label.
- Every mutation is authorized and checked against current session generation inside the committing transaction. A delayed previous incarnation cannot renew, acknowledge, complete, or release state owned by its replacement.
- A successful message acceptance response means message, idempotency record and event committed together. Sender retries with the same key return the same result; mismatched request bodies conflict. Commit-before-response crashes are recoverable.
- Delivery is at least once. Reading or receiving a notification does not acknowledge processing. Explicit acknowledgement records the recipient's durable processing decision and is idempotent. Reconnects replay unacknowledged messages with stable identifiers.
- Storage is bounded through explicit policy: quotas/backpressure before accepting new work, acknowledged-message retention, dead-letter/expiry states visible to sender and recipient. Accepted unread messages are never silently deleted because a recipient is offline. Expiry is an observable terminal disposition.
- Task intent is separate from execution attempt. Each claim/retry receives a new attempt token. Progress, completion, cancellation acknowledgement and reservation release compare actor generation and current attempt token atomically.
- Lease expiry permits recovery but does not prove that the old process stopped. Fencing prevents its later database writes from being accepted. External side effects still require idempotency and cooperative fencing; exactly-once filesystem or network actions are not promised.
- Adapter liveness is distinct from model/task progress. A running stdio proxy cannot indefinitely renew a stalled execution merely because its timer fires. Process availability, execution heartbeat, progress age and bounded task lease are tracked separately.
- Canonical workspace/file identities are reserved, reservations attach to task attempts, and isolated Git worktrees are preferred for concurrent editing. Reservations and write hooks are cooperative; they cannot stop arbitrary processes writing the same files.
- Completed results and referenced artifacts outlive session cleanup. Summary, structured evidence, producer attempt, content digest/URI and retention policy are persisted. Artifact deletion accounts for live references. Large artifacts stay out of message text.
- Events use monotonically ordered persisted cursors. Notifications are hints that new state may be available; reconnect queries replay from a cursor. If retention overtakes a reader, the coordinator returns an explicit resync requirement and a bounded snapshot.
- The coordinator serializes domain writes with short transactions and a bounded queue. It never awaits network, host wake, model execution or artifact upload while holding a SQLite transaction.

The production IPC service groups at most 32 already-queued ordinary commands per
event-loop turn, partitioned by authorized scope. Each command has a savepoint;
rejection rolls back that command without accepting partial writes. The outer
transaction commits with SQLite `synchronous=FULL` before any successful response
or notification is published. Receipts and events commit together, so loss of a
batch response is handled by ordinary stable command-ID replay. External provider
calls and asynchronous artifact imports remain outside these batches. Shutdown
rejects commands that have not entered a transaction. This reduces physical
durable commits without weakening acceptance semantics or waiting for a batch to
fill. Node/Bun crash fixtures cover exits before and after the outer commit.
- Coordinator restarts acquire a new persisted authority epoch. All write paths validate that epoch, including an old service process that resumes after replacement. Local singleton IPC ownership and database epoch checks prevent two accepted writers.
- One injected clock authority makes expiry decisions and monotonic elapsed time drives live timers. Clock jumps and restart behavior are tested. Model-provided timestamps are metadata, not lease authority.

## Boundaries and trust

1. Domain core owns commands, validation, state transitions, deduplication, migrations, cursors and retention. It has no SDK, terminal manager or tracker imports.
2. Local service owns process lifecycle, OS-local endpoint, bounded queues, subscriptions, clock and persistence. It can recover without any MCP client remaining connected.
3. MCP adapter maps typed requests/results and legacy compatibility onto the core. The current protocol requires explicit cross-call handles; a transport connection is never treated as durable actor identity. Tool discovery is deterministic and independent of registered role.
4. Host adapters provide verified lifecycle, relevant inbox injection, processing acknowledgements and wake capability. Capability negotiation distinguishes notifications the host can display from delivery the model will actually receive. Manual clients use explicit bounded sync.
5. Native runtime remains execution authority for its own children. A handoff selects one execution route and persists the intent/attempt mapping; retries cannot spawn both a native child and an independent worker.
6. Workspace adapters own launch, attach, stop, worktree placement and advisory display handles. A pane identifier is never an actor credential or task identifier.
7. Tracker adapters publish durable engineering evidence when configured. Tracker outages do not block message acknowledgements or create duplicate execution.
8. Profiles use separate database paths, IPC endpoints and OS access controls. Labels and role strings are routing metadata. Same-user direct database access is outside the API authorization boundary; label filtering is not hostile multi-tenant isolation.

The protocol handling was checked against the [official 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) and [SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/). New-style discovery/subscription handling and legacy stdio support are described in [MCP protocol compatibility](mcp-v2-compatibility.md) and the [compact API](compact-api.md). Domain task attempts remain distinct from the optional MCP Tasks extension; transport notifications do not establish processing acknowledgement.

## Supported matrix

- Release gate: local Windows, Bun and Node stdio adapters, with Codex and Claude Code MCP clients. Core and simulated SDK-client tests pass on hosted Windows and Ubuntu CI; real installed-host lifecycle verification is required before automatic delivery is advertised for a host. Per-host evidence and limits are in [runtime host support](runtime-host-support.md).
- Manual generic MCP clients receive explicit sync/ack tools. A host without verified injection or wake capability is supported only in manual mode, reported by diagnostics.
- The existing Hermes adapter contract is preserved and tested against the new core; its actual-host delivery is unverified, so automatic delivery is not advertised for it.
- OpenCode support rests on installed-host lifecycle evidence, not on an MCP configuration example.
- Unix sockets and portable core contracts are designed in, and the automated gate passes on Ubuntu, but macOS/Linux installed-host automation is not verified. A platform must pass its contract suite before release claims include it.
- Desktop/mobile consumers remain on a compatible read interface or are explicitly version-refused. They do not continue silently mutating coordination tables. Network deployment and multi-machine storage are deferred.

## Acceptance budgets

These engineering targets were derived after baseline measurement and are met by the benchmark gate recorded in [coordination benchmarks](coordination-benchmarks.md). Identical workloads run on the recorded Windows machine; platform-specific baselines are established when a platform is added.

| Metric | Required gate |
|---|---|
| Accepted message silent loss | 0 across disconnect/crash/retry/expiry tests |
| Accepted stale-session or stale-attempt mutation | 0 |
| 2/8/32-agent local delivery, no model inference | p95 <= 100 ms, p99 <= 250 ms after warmup |
| 32-agent ring workload | >= 250 delivered messages/sec, 384/384 accepted and eventually read; no SQLite busy error exposed |
| Steady idle resource use, 32 attached agents | <= 2% of one core over 60 seconds after warmup; no model-visible idle calls |
| Coordination owner RSS | <= 256 MiB steady-state on this fixture; report private/working-set memory as well as summed RSS |
| End-to-end adapter memory | <= baseline total at equivalent count; report per-host runtime overhead separately |
| Default startup/sync text | <= 1000 explicit o200k_base tokens per agent at 32 agents, excluding user task/artifact content |
| Default core catalog | <= 3000 explicit schema tokens; optional administrative detail fetched on demand |
| Steady delivered handoff | <= 2 model-visible coordination calls with automatic adapters; <= 3 in manual sync mode, excluding the actual work |
| Restart/reconnect | replay ready within 5 seconds after service availability; no acknowledgement inferred from transport success |

Performance tests preserve FULL durable commit semantics and the acknowledgement/fencing contract. Green budgets are never obtained by dropping fsync, omitting events, ignoring failed accepts, or calling unprocessed deliveries acknowledged. Longer scenarios include bursts, slow consumers, saturated inboxes and recovery; the short prototype is only the design baseline.

## End-to-end API shape

Illustrative contract; the tool names and schemas are in the [compact API](compact-api.md):

1. Adapter opens/resumes actor `reviewer` and receives session handle/generation plus event cursor.
2. Lead creates task intent `review:change-42` with an idempotency key, bounded contract, artifact references and chosen execution route.
3. Coordinator commits the task/inbox event and returns task ID. A best-effort wake follows the commit.
4. Reviewer syncs relevant inbox and claims an attempt. Reading does not acknowledge. It records processing acknowledgement once the handoff is accepted into its execution state.
5. Reviewer submits progress/results using session generation and attempt token. The result and completion event commit together.
6. Lead receives the completion reference through its adapter; a reconnect replays from the saved cursor.
7. If the old reviewer resumes after reassignment, its completion returns `stale_attempt`; it cannot release the new owner's reservation.

## History

The implementation was delivered under VUH-1332..VUH-1344 (September 2026): the domain/service transaction seam and versioned store, acknowledged inboxes and fenced attempts, workspace coordination and durable results, protocol/API/host adapters, native execution routing, diagnostics, fault tests, budgets and migration. The verification work this decision anticipated (actual host delivery capabilities, restart/epoch behavior, long-duration resources and Windows/Node adapter performance) is recorded in [coordination verification](coordination-verification.md), [coordination benchmarks](coordination-benchmarks.md) and [runtime host support](runtime-host-support.md). Changing topology requires new evidence and an updated ADR.
