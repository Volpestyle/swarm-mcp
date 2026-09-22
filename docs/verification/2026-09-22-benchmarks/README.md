# Production coordination benchmark campaign

VUH-1343 remains in progress. This archive establishes the short ring workload,
60-second idle comparison, small/no-work cases and explicit MCP token counts.
This campaign does not establish the mixed-host, disconnected/slow consumer,
saturated backlog, fairness or recovery budgets. The subsequent
[consumer campaign](../2026-09-22-consumers/README.md) adds measured transport
reconnect, saturation and slow-consumer evidence; mixed-host work remains open.

## Environment and provenance

Windows 10.0.26200, Intel i9-14900KF, 32 logical CPUs, 34,034,339,840 bytes RAM,
Bun 1.3.11, Node 22.14.0. Runs were sequential; no test campaign or dependency
installation was deliberately overlapped with the retained performance samples.

Production uses the built Node owner and independent Bun IPC clients, with
SQLite WAL and synchronous FULL. Each actor sends 12 ring messages with a
256-character body and 73 ms spacing after a two-second warmup. Idle samples
are 4.2 seconds except the explicit 60-second pair. Legacy uses the production
legacy modules with two-second polling and destructive read marking. Legacy
read marking is not processing acknowledgment.

The authoritative post-grouping 32-agent run is `074b1ef`, with an empty textual
source diff. Its source block records the owner bundle and harness hashes.
Final 1/2/8-agent and no-work runs use that same production code; the dirty
baseline warmup change is captured in `baseline-warmup.patch`. The 60-second
legacy run uses that optional warmup. Fresh legacy 2/8/32 samples predate it.
The initial production-2 run predates the lazy SDK import; production-lean-2,
production-8, production-32 and the profile capture use `f9a0a1b` production
code. The initial harness was not yet committed in the first production-2 run.

Raw files retain their original metadata and limitations. `sha256.json` covers
the raw files, gate logs and baseline patch. Fixture paths and identities refer
to isolated temporary databases, not live swarm sessions. Explicit MCP captures
use synthetic task text and fixture-only leases. Captures were made at `074b1ef`
with only the baseline warmup change; the tokenizer later added per-call extrema.

## Results

| Workload | Accepted / acknowledged | Delivery p50 / p95 / p99 ms | Ack p50 / p95 ms |
|---|---|---|---|
| Production, 1 agent | 12 / 12 | 6 / 9 / 9 | 7 / 10 |
| Production, 2 agents | 24 / 24 | 6 / 8 / 8 | 10 / 11 |
| Production, 8 agents | 96 / 96 | 8 / 10 / 15 | 14 / 16 |
| Production, 32 agents, 60-second idle | 384 / 384 | 27 / 32 / 89 | 45 / 54 |

The 32-agent production sample delivered 281.94 messages/sec, with zero reported
errors and no SQLite busy errors. Idle CPU summed over workers and owner was
1.57% of one core. Owner working set was 55,619,584 bytes and private memory
63,987,712 bytes. Summed worker RSS was 4,464,160,768 bytes; shared pages mean
this is not unique physical memory. The owner plus workers used less reported
resident memory than the matched legacy sample (5,292,654,592 worker RSS bytes).
This compares fixture processes, not full end-to-end host adapter memory.

The matching 32-agent legacy run accepted and read 373 of 384 attempted sends,
with 11 database-lock errors, no unread accepted messages, p50/p95 delivery
1,456/3,404 ms, throughput 46.20/sec and idle CPU 3.72% of one core. Acknowledgment
latency is unavailable because the legacy contract has no processing ack.

The first production 32-agent run missed the budget: p95 274 ms and throughput
178.27/sec. The retained CPU profile pointed to native SQLite transaction calls;
measured writer-lock acquisition itself was only a few milliseconds in total.
Bounded grouping of up to 32 already-queued commands reduced physical commits
without delaying to accumulate work or weakening fsync. Per-command savepoints
isolate rejection; responses and notifications follow the outer durable commit.
The final sample reports 138 writer acquisitions, versus 1,025 before grouping.

Keep the earlier two-agent outlier visible: the lean-SDK run had p95 113 ms.
The final post-grouping run passed, but these are individual samples, not a
statistically established distribution or a guarantee against system stalls.

No-work samples at zero and one actor had zero accepted messages and no errors.
Over the short 4.2-second window, measured idle CPU was zero at the available
resolution. Owner working sets were 54,480,896 and 54,759,424 bytes; the attached
worker RSS was 153,624,576 bytes. The one-actor run had two total IPC requests
(bootstrap and a held wait), not model-visible idle polling. Zero measured CPU
over this short window is not proof of zero ongoing cost.

## Explicit MCP context

`measure-compact-context.ts` drives actual Node stdio MCP adapters. Enrollment is
outside the model surface. Each agent performs sync, send, fetch and explicit
acknowledgment. There is no inference or native-host prompt measurement.

| Agents | Calls including initial sync | Argument + text-result tokens |
|---|---|---|
| 2 | 8 | 952 |
| 8 | 32 | 3,734 |
| 32 | 128 | 15,128 |

The nine-tool schema is 2,846 `o200k_base` tokens, plus 73 instruction tokens.
Every sync text result is 31 tokens, including at 32 agents. Manual steady
handoff uses three calls after sync. The automatic-adapter two-call target
requires separate host evidence. Hidden framing, duplicated structured content,
reasoning, caching and billing are excluded. Counts use pinned tiktoken 0.12.0.

## Reproduce

Build with `bun run build`. Run each measurement sequentially:

```powershell
bun scripts/benchmark-coordination.ts 2 dist/test/production-2.json
bun scripts/benchmark-coordination.ts 8 dist/test/production-8.json
bun scripts/benchmark-coordination.ts 1 dist/test/production-1.json
$env:SWARM_BENCH_IDLE_MS='60000'
bun scripts/benchmark-coordination.ts 32 dist/test/production-32.json
$env:SWARM_BENCH_WARMUP_MS='2000'
bun scripts/benchmark-baseline.ts 32 | Set-Content -Encoding utf8 dist/test/legacy-32.json
Remove-Item Env:SWARM_BENCH_IDLE_MS, Env:SWARM_BENCH_WARMUP_MS
$env:SWARM_BENCH_MESSAGES='0'
bun scripts/benchmark-coordination.ts 0 dist/test/no-work-0.json
bun scripts/benchmark-coordination.ts 1 dist/test/no-work-1.json
Remove-Item Env:SWARM_BENCH_MESSAGES
bun scripts/measure-compact-context.ts 32 dist/test/context-32.json
uv run --with tiktoken==0.12.0 python scripts/count-context-tokens.py dist/test/context-32.json
```

Use `SWARM_BENCH_PROFILE=1` for a diagnostic CPU profile, then remove it before
budget measurements. The harness exits nonzero for incomplete delivery; the
budget verifier below enforces the measured subset of architecture budgets.
Its defer option leaves the consumer connected and is
not a physical-disconnect test. Transport byte counts omit framing; commit-time
delivery measurements include commit duration. Host wake and inference latency
are absent. The native-runtime comparison and representative task/user-prompt
accounting remain outstanding.

## Executable budget check

`scripts/verify-coordination-budgets.py` accepts explicit captures for 2/8/32
agents, a matched legacy 32-agent baseline and tokenizer output. It enforces
the selected workload, unique and durably acknowledged deliveries, WAL/FULL
writer evidence, no busy errors, p95/p99 latency, owner working/private memory,
60-second idle CPU, throughput, fixture resident-memory comparison, core schema
tokens, per-agent sync text and manual handoff call counts. Latency and throughput
are recomputed from samples rather than trusting their summary fields.

```powershell
$raw='docs/verification/2026-09-22-benchmarks/raw'
python scripts/verify-coordination-budgets.py --agents2 "$raw/benchmark-production-batched-final-2.json" --agents8 "$raw/benchmark-production-batched-final-8.json" --agents32 "$raw/benchmark-production-idle60-32.json" --baseline32 "$raw/benchmark-baseline-idle60-32.json" --tokens "$raw/benchmark-context-tokens.json"
```

Use newly generated paths to gate a fresh campaign. The retained captures pass;
the output is retained in `budget-verification.json`. Negative checks rejected
a missing acknowledgment and a copy with every delivery delayed to 274 ms.
The original pre-optimization capture also fails, first because it lacks the
later writer-durability metadata; do not claim that specific invocation reached
the latency check. An initial verifier KeyError on that absent field was corrected
to an explicit rejection before recording these checks.

This checker does not prove full-host memory, native-only performance, real-host
automatic behavior, crash/restart invariants or hosted CI. Those require their
own evidence. See the [mixed-host capture](../2026-09-22-mixed-host/README.md)
for actual host call/prompt accounting and the
[consumer verifier](../2026-09-22-consumers/README.md) for reconnect/saturation.

## Correctness gate

`gate/manifest.json` records `074b1ef` with unchanged source throughout the run.
Typecheck and build passed; 160 tests across 44 files produced 1,329 assertions,
plus 48 Python tests. Batch tests cover rejected-command savepoint isolation,
scope separation, visibility after commit, and abrupt Node/Bun exits before and
after batch commit. Logs are retained verbatim. This is local Windows evidence;
the prepared hosted CI workflow has not run.
