# VUH-1337 verification

`bunx tsc --noEmit`, `bun run build` and frozen-lockfile installation pass.
The full Bun suite reports 270 pass, 38 fail, 1,036 assertions and 308 tests
across 22 files. All 38 normalized failure names match the previous evidence
baseline exactly. Output is retained in `full-suite.log`.

The three real subprocess protocol tests cover both legacy-handshake and pinned
2026-07-28 clients: discovery, tool/resource/prompt catalogs, registration, inbox
reads, raw result/cache/server-identity fields, selected task notifications,
unsubscribe, independent peer inbox notifications, wait cancellation and continued
requests, EOF shutdown without forced termination, unsupported opening revisions,
missing/malformed request metadata and recovery with a valid request.

The published SDK pins the codec for a connection; its handling of later
well-formed version strings is documented in `docs/mcp-v2-compatibility.md`.
That document also records cache choices, installed-host limits and the Tasks
extension decision. These tests use disposable databases, not the configured
live legacy database. Runtime wake behavior remains VUH-1339 work.
