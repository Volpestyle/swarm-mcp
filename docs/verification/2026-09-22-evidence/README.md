# VUH-1336 verification

Candidate branch: `redesign/coordination-core`, based on `a59a8b7`.
All fixtures use isolated databases; the configured legacy runtime is unchanged.

`bunx tsc --noEmit` and `bun run build` pass. `bun test` reports 267 passing,
38 failing tests and 993 assertions across 21 files. The normalized failure names
exactly match the prior reservation baseline's 38 failures (Windows subprocess,
path parsing and gateway/workspace fixtures); no new failure was introduced.
The complete output is retained in `full-suite.log`.

Evidence against acceptance criteria:

- Result/decision/annotation records carry author/session, task/attempt when
  relevant, full revision, files, timestamp and verification. Tests reject an
  expired attempt, cross-scope artifact references and unstable revisions.
- Captured artifact bytes survive source deletion and store restart; byte pages
  reconstruct the original report. Corruption after a successful cached read is
  detected. Real Bun and Node subprocesses exit on both sides of metadata commit;
  recovery either retries a complete capture or replays the accepted reference.
- Task result expiry hides current result values, preserves control history and
  leaves independent findings intact. Findings and artifact links visibly expire;
  another author cannot change retention. Default storage persists through close.
- Annotation queries distinguish matching, stale and unknown revisions and filter
  by file/task. Pagination spans multiple pages; missing blob links stay visible.
- Eight concurrent Bun writers and eight concurrent Node writers each produce one
  CAS winner and retain all eight atomic appends. Replay, deletion/expiry versions,
  restart history, scope and size limits are covered.
- The authenticated Node owner serves imported bytes, linked findings and shared
  KV through the real IPC client.

See `docs/retained-context.md` for retention semantics and limits. Expiry is not
physical erasure; audit receipts and blobs remain stored. Installed-host delivery,
the compact MCP surface and power-loss testing are not implied by these tests.
