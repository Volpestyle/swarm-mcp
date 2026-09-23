# Coordination benchmarks

Benchmark evidence covers the selected Windows fixtures. These are local
benchmark results, not hosted CI evidence. The benchmark implementation matched
the full local failure gate at `074b1ef`; its evidence archive was completed at
`71e3dd3`. Migration and startup compatibility landed afterwards; the context
recheck below covers the resulting bootstrap metadata change without relabeling
earlier measurements.

| Requirement | Inspected evidence |
|---|---|
| Matched 2/8/32-agent workloads, one-agent/no-work cases | [Ring campaign](verification/2026-09-22-benchmarks/README.md): full counts, p50/p95/p99, acknowledgment, CPU, memory, throughput and contention |
| Real mixed-host representative task and prompt/call accounting | [OpenCode/Claude campaign](verification/2026-09-22-mixed-host/README.md): installed hosts, one completed attempt, two acknowledged messages, four emitted tools, one explicit Claude turn |
| Payload/token volume | Actual stdio transcripts and pinned tokenizer reports in the ring campaign; full host request JSON counts separately in mixed/native captures |
| Slow/disconnected consumers, bounded backlog and peer progress | [Consumer campaign](verification/2026-09-22-consumers/README.md): 1,000-message quota, explicit rejects, healthy-peer completion, bounded batches, held waits and replay timing |
| Native runtime comparison with different guarantees explicit | [Native/memory campaign](verification/2026-09-22-native-memory/README.md): actual native task tool without Swarm, plus durable mixed route; no misleading speed ratio |
| Actual adapter memory and separate host overhead | 32 stdio adapters plus owner: 2.22 GB working set versus 6.19 GB baseline; host root processes recorded separately |
| Reproducible checked-in harnesses, raw data and limitations | Each campaign has commands, raw captures, source provenance, checksums and limitations; failed/outlier runs remain visible |

## Selected budget results

| Budget | Evidence/result |
|---|---|
| No silent accepted-message loss or superseded-owner mutations | [Verification gate](coordination-verification.md) and retained exact `074b1ef` gate; consumer captures account for every accepted message and explicit quota rejection |
| 2/8/32 delivery p95 <=100 ms, p99 <=250 ms | p95 8/10/32 ms; p99 8/15/89 ms |
| 32-agent throughput >=250/sec and 384/384 accepted | 281.94/sec, all accepted and durably acknowledged, no busy errors |
| 32-agent idle CPU <=2% of one core over 60 seconds | 1.57%; held adapter waits, no model-driven idle polling |
| Owner steady fixture resident memory <=256 MiB | 55,619,584 working-set bytes; private memory reported |
| Actual adapter memory <= equivalent baseline | Actual stdio 32+owner working/private memory below 32 legacy processes; different runtimes disclosed |
| Sync <=1000 explicit tokens per agent | Maximum 31 at 32 agents |
| Core schema <=3000 tokens | 2,846 schema tokens, 73 additional instruction tokens |
| Automatic handoff <=2 model-visible coordination calls, manual <=3 | Two peer directions consume four emitted tools total; manual stdio uses send/fetch/ack. Bash helpers group multiple underlying commands; no reduction in durable operations claimed |
| Reconnect replay ready <=5 seconds | 137–202 ms to first replay; saturated 1,000-message inbox drained in 2.03 seconds |

## Executable checks

- `scripts/verify-coordination-budgets.py`: selected ring, resource and compact-API budgets; reconstructs latency/throughput from samples.
- `scripts/verify-consumer-benchmarks.py`: accepted-message accounting, quota, recovery and healthy-peer progress.
- `scripts/verify-adapter-budgets.py`: actual adapter memory and bounded native/mixed-host behavior.

Each verifier accepts paths to fresh captures and exits nonzero on failure.
Archived captures pass; negative checks reject missing acknowledgments, excessive
latency and excessive adapter memory. The separate verification gate covers
crashes, stale ownership and protocol semantics. These local results are not
hosted CI executions and do not replace the isolated migration canary and
rollback proof in the [cutover guide](migration-cutover.md).

## Context recheck at 2.0.0-rc.1

Bootstrap carries compatibility metadata. At runtime revision `4621877`, real
stdio captures for 2 and 32 agents measured 2,870 schema tokens plus 73
instruction tokens, maximum sync text 103 tokens, and three manual handoff calls
after sync. The catalog remains below its 3,000-token budget. See the
[rc.1 capture and provenance](verification/2026-09-22-rollout/README.md). The
earlier latency/CPU/host measurements above remain evidence at their stated
revisions; this is a context recheck, not a rerun of those campaigns.

History: delivered under VUH-1343 (September 2026); merged in PR #9.
