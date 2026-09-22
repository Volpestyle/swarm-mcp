# Coordination failure gate (VUH-1342)

Run `bun scripts/verify-coordination.ts` from the candidate checkout. The gate
performs type checking, builds production entrypoints, runs every
`coordination-*.test.ts` plus `mcp-protocol.test.ts`, then runs the shared
Python/Hermes lifecycle tests. It creates a timestamped directory beneath
`dist/verification/coordination` with full output and a manifest containing the
revision, working-tree fingerprint, platform, runtime versions, commands, exit
codes and durations. A source change during verification invalidates the run.

Tests use disposable databases and host fixtures; they do not attach to the live
swarm. Process fixtures use deterministic abrupt exits at transaction fault
points. These establish process-crash recovery, not power-loss or filesystem
hardware guarantees. Do not run additional test campaigns against the same
checkout while collecting the gate: they compete for process resources, and
editing loaded test files prevents attribution to one source revision.

## Coverage map

| Invariant/scenario | Tests |
| --- | --- |
| Atomic state/event/receipt; before/after-commit and migration crashes; concurrent startup; equal timestamps | `coordination-core` |
| Accepted messages survive fetch/ack response loss; concurrent consumers; delayed/dead-letter work; scoped recipients | `coordination-inbox`, `coordination-inbox-backlog` |
| Renewal exits before/after commit in Node and Bun; one renewal event after replay; stale completion; lease recovery; cancellations/dependency cascades | `coordination-tasks` |
| Restart adoption, capability fencing, profile boundaries, transport vs runtime evidence | `coordination-sessions`, `coordination-runtime-launcher` |
| One dispatch effect; retained uncertainty; cancellation proof; native-to-peer fence change | `coordination-dispatch*`, `coordination-owner*` |
| Real modern/legacy stdio, resources/subscriptions, output schemas, metadata negotiation, repeated cancelled waits | `coordination-mcp*`, `mcp-protocol` |
| Disconnect cleanup, resumed waits, authorization, real Node CLI | `coordination-ipc` |
| Safe delivery boundaries, host snapshots/reconnect, wake uncertainty, deduplication | runtime, inbox-observer, OpenCode, Claude and Codex tests |
| Worktree/file isolation and real subprocess write hooks | worktrees, reservations and write-hooks tests |

Cancelled stdio waits are repeated beyond the adapter's eight-wait limit, then
another wait succeeds; the task remains running throughout. This distinguishes
request cancellation from task cancellation and checks slot cleanup.

## Installed-host smoke

First discover the installed native executable and version. Use the explicit
executable path, isolated fixture state and local scripted model endpoints:

```powershell
bun run build
bun scripts/probe-opencode-dispatch.ts dist/test/native.json <native-opencode-executable>
bun scripts/probe-opencode-hooks.ts dist/test/opencode-leases.json <native-opencode-executable> --lease-expiry
bun scripts/probe-claude-hooks.ts dist/test/claude-mcp.json <native-claude-executable> --mcp
bun scripts/probe-claude-hooks.ts dist/test/claude-resume.json <native-claude-executable> --restart
```

Inspect one accepted owner/result, explicit acknowledgment, busy/blocked deferral,
retained delivery across recovery and revoked old credentials. A successful host
wake is not acknowledgment. Preserve failed captures, identify the actual host
and tested source, and retain the support limitations in
[runtime acceptance](runtime-acceptance.md). The existing captures there are
reused evidence, not CI results or new host runs.

## CI delivery

`.github/workflows/coordination.yml` runs this same gate on Windows and Ubuntu
with Node 22, Bun 1.3.11 and Python 3.12, retaining logs even on failure. Installed
interactive hosts are optional smoke checks outside that automated fixture gate.
The workflow is prepared locally. No hosted CI execution is claimed until this
candidate has an authorized writable remote and an inspected Actions run; the
currently archived origin has not been changed or pushed to.
