# Reservation and hook verification

Windows; Bun 1.3.11, Node 22.14.0, real Python subprocess hooks and Git worktrees.

- `bun test`: **249 passed, 38 failed, 844 assertions**; [retained output](full-suite.log).
  Exact normalized failed-test names match the identity baseline's 38 failures.
- `bunx tsc --noEmit`: passed.
- `bun run build`: passed; emits `dist/coordination/client-cli.js` and the existing entrypoints.
- Python shared hook, adapter-contract and Hermes suites: **51 passed**.

Two subprocess writers invoke the real Claude-style pre-hook against a Node owner.
One writes the file; the other receives a denial. The winner's post-hook releases
its grant, after which the loser retries and writes. The Codex-style rename hook
reserves both source and destination; a conflict on the destination acquires
neither. Malformed path metadata, missing call IDs and an unreachable owner deny
opted-in writes.

An integration grant blocks a wrapped `git merge --ff-only` in a real linked
worktree. The target file retains its old contents while denied; after release,
the actual merge succeeds and the file contains the candidate revision. An expired
grant in the Node owner is replaced with a higher fence and its old client's late
release is rejected.

Core scenarios cover atomic multi-file acquisition, nested grant reuse,
session/attempt fencing, expiry, cross-worktree logical warnings, and integration
exclusion of peer writes in the target checkout while other worktrees remain free.
Canonical-path tests include Windows case folding and symlinked missing-file
ancestors. These are hook-contract tests, not a claim that installed host versions
emit every hook or that arbitrary filesystem writes are intercepted.

## Startup race found during this run

The first broad run exposed `incompatible_database` in one concurrent Node startup.
The pre-migration identity check read the old application ID, another process
committed migration, then the first read the new schema tables. The check mixed
two valid database states and falsely refused its own database.

A deterministic two-connection test forces that exact interleaving. It failed
before the fix with “Not a coordinator database” and passed after wrapping the
initial identity inspection in one read transaction. The writer-locked validation
still runs again before migration. The final full run includes this regression
test plus independent concurrent Node and Bun startup tests.

See [reservation setup and coverage limits](../../worktree-reservations.md).
