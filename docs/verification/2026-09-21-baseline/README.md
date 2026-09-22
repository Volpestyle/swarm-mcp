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

The next experiment should attribute the 32-process contention (including
opportunistic cleanup) and compare a lean transaction path with coalesced wake
notifications. These results do not by themselves prove that a daemon is needed.
VUH-1331 stays open pending that comparison, actual host/API costs, the supported
host matrix and the final design decision.
