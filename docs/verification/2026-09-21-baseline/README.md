# Baseline evidence

VUH-1330 baseline sources: April `b446c18` and final upstream `b95f607`.
See [the change map and maintenance decision](../../redesign-baseline.md).

The `.log` files retain test output, including Windows PowerShell stderr
formatting. Encoding was normalized to UTF-8 and trailing whitespace trimmed.
The two loss reproductions use fresh temporary databases and production modules;
they intentionally assert the historical failure behavior.

## VUH-1331 preliminary module workload

Run `bun run scripts/benchmark-baseline.ts 2` (also 8 and 32) from the redesign
worktree. Each run uses independent Bun processes, final-upstream modules, one
temporary SQLite database, and a registration barrier. Each agent sends 12
messages in a ring at 73 ms intervals, with 256-byte bodies plus timestamp and
sequence metadata. Polling is every two seconds. The idle sample is 4.2 seconds;
delivery observation ends eight seconds after that worker starts sending.

Hardware: Intel Core i9-14900KF, 32 logical processors, 34,034,339,840 bytes
physical memory, Windows 10.0.26200, Bun 1.3.11. Runs were sequential.

| Agents | Accepted / attempted | Received | Unread at end | p50 / p95 delivery ms | Delivered / sec | Aggregate worker RSS MiB | Idle CPU % of one core | Operation p95 ms |
|---|---|---|---|---|---|---|---|---|
| 2 | 24 / 24 | 24 | 0 | 1276 / 1822 | 12.97 | 302.55 | 0.00 | 18.22 |
| 8 | 96 / 96 | 96 | 0 | 1164 / 1852 | 50.18 | 1247.04 | 0.36 | 82.09 |
| 32 | 379 / 384 | 360 | 19 | 1535 / 3398 | 44.79 | 4989.36 | 1.83 | 1537.30 |

The 32-agent run returned five `SQLiteError: database is locked` errors. The 19
unread messages remained in storage; this run does not establish that they were
lost. The attempted-message count is fixed by the workload. Accepted means the
production send function returned successfully, not that processing was
acknowledged. No duplicate deliveries were observed.

Serialized request/response bytes: 10,126 / 9,749 (2 agents), 40,504 / 39,023
(8 agents), 163,849 / 146,692 (32 agents). Simulated coordination calls including
registration, send and polling: 32, 128, 554. These are workload proxies, not
measurements of model-visible calls in a live host. Exact model token cost remains
unmeasured; do not convert bytes into a claimed token count.

Limits: these are single samples, not release budgets. Module-worker RSS includes
shared pages and excludes host/model memory. Short idle CPU samples are coarse;
zero measured CPU is not proof of zero cost. Production-operation timing includes
SQLite work and contention, not separately measured lock wait. The full MCP
notification timer, JSON-RPC serialization, adapter wake, host context injection,
and model tokenization are excluded. Startup schema initialization runs before
the barrier. No crash faults were injected.

## Follow-up architecture experiments

The [selected architecture](../../coordination-architecture.md) records the
comparison, supported matrix, guarantees and budgets. No production behavior was
changed by these experiments.

- `SWARM_BENCH_MODE=no-cleanup` with `benchmark-baseline.ts 32` excludes incidental
  cleanup but retains separate message/event statements. Result: 376 accepted,
  361 read, eight operation errors, p95 3218 ms.
- `SWARM_BENCH_MODE=atomic` additionally puts each message/event mutation in an
  immediate transaction. Result: 381 accepted, 372 read, nine operation errors,
  p95 3521 ms. Errors include reads; do not call all nine failed sends.
- `benchmark-broker.ts` runs a disposable single writer over loopback HTTP with
  separate client processes. It deliberately retains destructive reads for
  comparability; it is not the reliable inbox implementation.
- `experiment-broker-32.json` is the first cold sample with one-second waits.
  `experiment-broker-warm-{2,8,32}.json` adds two seconds of connection warmup and
  retains one-second waits (`SWARM_BENCH_HOLD_MS=1000`). At 32 agents, p95 was
  44 ms with no errors, but idle CPU was 16.7% of one core.
- `experiment-broker-held-32.json` and `experiment-broker-held-repeat-32.json`
  use 30-second held waits (the current default). Both delivered 384/384 with
  no errors. Use the clean repeat: p95 36 ms, 286 delivered/sec, idle CPU 0.74%
  of one core. The first held-wait sample overlapped tokenizer installation;
  the repeat did not.

Real MCP text captures use `bun run scripts/measure-mcp-context.ts 2` (also 8
and 32). These spawn actual stdio MCP servers using isolated databases and drive
register/bootstrap/send/poll. They assert that every ring message is returned.
The recorded catalog has 33 tools.

Token counts use `python scripts/count-context-tokens.py <capture> ...` with
`tiktoken==0.12.0` installed in an isolated environment. This campaign installed
it under the temporary `swarm-benchmark-tokenizer` directory and set `PYTHONPATH`
for the count command; no production dependency was added. Results use
`o200k_base`, count explicit JSON arguments and text results, and separately
report schema text. They do not estimate hidden host framing or provider bills.

| Agents | Calls | Argument + result tokens | Bootstrap result tokens |
|---|---|---|---|
| 2 | 8 | 2534 | 1306 |
| 8 | 32 | 20288 | 15440 |
| 32 | 128 | 246300 | 226816 |

Each full catalog is 6042 tokens; deferred tool discovery can change actual host
exposure. The full transcripts and counts are retained in `mcp-context-*.json`
and `mcp-token-counts.json`.
