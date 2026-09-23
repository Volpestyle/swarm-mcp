# Documentation

Current documentation for the swarm-mcp v2 coordinator on `main`. Legacy
interface docs are under [legacy/](legacy/README.md).

## Start here

- [Installation](installation.md): build, package, install the skill, wire a host launcher, run the doctor.
- [Compact API](compact-api.md): the nine tools, receipts, budgets, resources and subscriptions.
- [Architecture](architecture.md): the decision record, guarantees, trust boundaries and acceptance budgets.

## Contracts

- [Durable inboxes](durable-inboxes.md): at-least-once delivery, leases, acknowledgment, replay and expiry.
- [Session and task ownership](session-and-task-ownership.md): actor identity, generations, attempts and fencing.
- [Worktree reservations](worktree-reservations.md): worktree identity, file reservations and write hooks.
- [Retained context](retained-context.md): results, artifacts, findings and shared context.
- [Execution routing](execution-routing.md): native children versus independent peers, dispatch and reconciliation.
- [Runtime delivery](runtime-delivery.md): what a host adapter must do to deliver and acknowledge.
- [MCP protocol compatibility](mcp-v2-compatibility.md): modern and legacy MCP clients.
- [Legacy caller compatibility](compact-api-migration.md): how legacy tool calls map onto the compact API.

## Operations

- [Startup compatibility](startup-compatibility.md): build, schema and skill contract checks; the doctor.
- [Coordination diagnostics](coordination-diagnostics.md): delivery and ownership diagnostics and recovery.
- [Migration and cutover](migration-cutover.md): reversible move from a legacy profile to a coordinator profile.
- [Package boundary](packaging.md): what the npm package contains and how it is verified.
- [Runtime host support](runtime-host-support.md): per-host verified paths and limitations.
- [Work tracker policy](linear-promotion-policy.md): when swarm work gets a tracker issue.

## Verification

- [Coordination verification gate](coordination-verification.md): the failure-injection suite, CI and evidence retention.
- [Coordination benchmarks](coordination-benchmarks.md): delivery, idle and context budgets.
- [verification/](verification/): retained evidence directories, one per date and topic, each with a README and gate manifest.

## History

- [Redesign baseline (2026-09-21)](history/2026-09-21-redesign-baseline.md): how the baseline and continuation were chosen.
- [Hosted CI first runs (2026-09-23)](verification/2026-09-23-hosted-ci/README.md): the runner defects the first CI runs exposed and their fixes.

## Diagrams

Mermaid sources and rendered PNGs live in [diagrams/](diagrams/README.md); render with `bun run diagrams`.
