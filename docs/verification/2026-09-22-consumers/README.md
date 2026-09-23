# Consumer disconnect, saturation and slow processing

> 6 raw captures named below were removed from the tree on 2026-09-23 (evidence prune); each remains in git history at `1fe258b`, e.g. `git show 1fe258b:docs/verification/2026-09-22-consumers/<file>`.

Measured on the Windows machine described in the [ring benchmark campaign](../2026-09-22-benchmarks/README.md).
All three final runs use committed harness revision `ba82e2a`; the source diff
hash is empty, and the production Node owner bundle is unchanged from that
campaign. Source and bundle hashes are included in each raw result. Measurements
ran sequentially without overlapping tests or installation work.

| Scenario | Accepted / acknowledged | Explicit quota rejections | Result |
|---|---|---|---|
| 8 agents, 64 messages each, consumer 0 disconnected for 5 seconds | 512 / 512 | 0 | First replay 202 ms after reconnect; initial drain 477 ms |
| 2 agents, 1,050 messages each in a burst, consumer 0 disconnected for 20 seconds | 2,050 / 2,050 | 50 | Exactly 1,000 pending at reconnect; first replay 137 ms; drain 2,030 ms |
| 8 agents, 64 messages each in a burst, consumer 0 delays processing by 150 ms/message | 512 / 512 | 0 | Slow consumer finished in 10.36 seconds; healthy peers in 606–622 ms |

All accepted messages were acknowledged once, with no pending, leased or
dead-letter remainder and no unexpected errors. In the saturated case, the
healthy peer completed all 1,050 acknowledgments before consumer 0 reconnected.
Every healthy peer made progress while the other consumer was disconnected in
the eight-agent case. These observations establish isolation from the delayed
recipient in these fixtures; they do not prove general scheduling fairness.

The owner retains WAL with synchronous FULL. The consumer closes its reader
and watcher sockets before sends begin and reconnects using its existing
capability. Its process and independent sender socket remain alive. This is
an actual receive-transport disconnect, not a process kill or owner restart.
Replayed messages are drained across batches of at most 50; a held event wait
resumes afterward. Filesystem fixture barriers do not drive inbox delivery.
The pending count at reconnect is scope-wide, not per-recipient. In the
saturated case the healthy peer had finished, so it isolates the disconnected
backlog. Continuous queue-depth sampling was not performed.

`verify-consumer-benchmarks.py` checks attempted-send accounting, unique message
IDs, exact acknowledgments, FULL durability, physical disconnect duration,
replay readiness within five seconds, healthy-peer progress and the saturated
1,000-message limit/drain. It passed against these captures. A corrupted copy
with its received count reduced by one was rejected as loss/duplicate evidence.
The benchmark also exits nonzero for incomplete or duplicated delivery after
saving its raw evidence. Typecheck and a normal two-agent regression run passed.

## Reproduce

Build with `bun run build`, then run sequentially in PowerShell:

```powershell
$env:SWARM_BENCH_DISCONNECT_MS='5000'
$env:SWARM_BENCH_MESSAGES='64'
bun scripts/benchmark-coordination.ts 8 dist/test/disconnect.json
$env:SWARM_BENCH_DISCONNECT_MS='20000'
$env:SWARM_BENCH_MESSAGES='1050'
$env:SWARM_BENCH_SPACING_MS='0'
bun scripts/benchmark-coordination.ts 2 dist/test/saturated.json
$env:SWARM_BENCH_DISCONNECT_MS='0'
$env:SWARM_BENCH_MESSAGES='64'
$env:SWARM_BENCH_SLOW_MS='150'
bun scripts/benchmark-coordination.ts 8 dist/test/slow.json
python scripts/verify-consumer-benchmarks.py --disconnect dist/test/disconnect.json --saturated dist/test/saturated.json --slow dist/test/slow.json
Remove-Item Env:SWARM_BENCH_DISCONNECT_MS, Env:SWARM_BENCH_MESSAGES, Env:SWARM_BENCH_SPACING_MS, Env:SWARM_BENCH_SLOW_MS
```

The subsequent [acceptance index](../../coordination-benchmarks.md) links the
mixed-host/native comparison, representative-task prompt accounting, actual
adapter memory comparison and remaining budget verifiers. The consumer verifier
is deliberately not a complete release gate.
