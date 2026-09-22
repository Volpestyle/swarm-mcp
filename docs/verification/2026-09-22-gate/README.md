# Failure gate evidence

The [passing manifest](passed/manifest.json) identifies revision
`e6d57744ed495ecef498a8f6dc093dc31e5885e1`, Windows x64, Node 22.14.0 and
Bun 1.3.11. The complete gate passed: typecheck, production build, 153 tests
across 42 files (1,287 assertions), and 48 Python lifecycle tests. Source
fingerprints matched before/after the run. The retained generated-protocol
working-tree entry has an empty textual diff; it was not staged or changed.

Logs are [typecheck](passed/1.log), [build](passed/2.log),
[TypeScript tests](passed/3.log) and [Python](passed/4.log).
This is a local run, not hosted CI evidence.

The subsequent `8bd929e` change moves SDK protocol metadata from domain
diagnostics to the IPC boundary. Its focused verification passed 16 tests and
63 assertions (dependency boundary plus actual IPC/CLI), TypeScript and build.
The full gate above was not rerun for that isolated dependency-placement change.
The new regression bundles the domain core and rejects transitive MCP/host SDK
runtime imports.

## Failures retained honestly

The [failed fixture log](failed-fixture/3.log) contains the first cancellation
test's timeout. It used the SDK v1 three-argument calling convention; v2 takes
options as the second argument, so the abort signal was ignored. The corrected
test passes on modern and legacy stdio without changing deadlines.

That diagnostic run's source changed while tests were loading, so its starting
manifest is not an exact attribution for every test. It is retained as a failure
trace, not an acceptance run. The runner now rejects source changes during a run.
An overlapping focused rerun also exceeded the existing 1.5-second shutdown
bound (1.686 seconds); the isolated full gate passed with that bound unchanged.

The initial runner launch also failed with Windows `uv_spawn 'bun'`/`ENOENT`.
The runner now uses its absolute Bun executable and resolves other executables
before spawning. Timestamped output directories preserve every later run.

## Remaining delivery boundary

The Windows/Ubuntu Actions workflow is checked in, with logs uploaded on success
or failure. Hosted execution remains pending an authorized writable release
destination. The archived origin and live swarm were not changed. VUH-1342 stays
open for its explicit CI-execution criterion; local verification is complete.
See [coverage and installed-host smoke](../../coordination-verification.md).
