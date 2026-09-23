# Native-only and actual adapter memory comparison

> 8 raw captures named below were removed from the tree on 2026-09-23 (evidence prune); each remains in git history at `1fe258b`, e.g. `git show 1fe258b:docs/verification/2026-09-22-native-memory/<file>`.

Final runs use `fc03f51`, with empty source diffs recorded in each memory sample.
They ran sequentially on Windows 10.0.26200, i9-14900KF, 32 logical CPUs and
34,034,339,840 bytes RAM. Bun 1.3.11 drives the fixtures; redesigned stdio
adapters and the fixture owner use Node 22.14.0. Legacy servers use Bun, matching
the baseline installation. Host versions are OpenCode 1.4.3 and Claude 2.1.278.

## Actual stdio adapter memory

Both captures launch 32 actual MCP servers, exercise discovery and one ring
handoff per agent, then wait two seconds before sampling explicit fixture PIDs.
Legacy registration/bootstrap/send/read and redesigned sync/send/fetch/ack have
different contracts. The redesign adds a fixture owner with the production
coordination core; its PID is included. The driver and model hosts are excluded
from this adapter comparison and host root processes are reported separately.

| Fixture | Working set bytes | Private bytes |
|---|---|---|
| 32 legacy Bun servers | 6,187,634,688 | 12,212,432,896 |
| 32 redesigned Node adapters + owner | 2,218,561,536 | 2,825,211,904 |

The selected adapter-memory target is met for this workload. This includes the
runtime change, full server code and schema differences; it is not an isolated
algorithmic memory saving. Working sets contain shared pages. These are sampled
values, not unique physical memory, simultaneous peaks or a long-duration leak
test. Raw rows include each PID, working/private memory and process-lifetime peak.

## Native-only comparison and host overhead

With Swarm plugin/MCP disabled, no coordinator started, the actual OpenCode
`task` tool created one general child and returned its result to its parent.
It took one native tool call, three local model-endpoint requests and one explicit
user prompt; the prompt-to-result interval was 474 ms. Its host root working set
was 702,218,240 bytes (private memory is in the raw sample).

The actual OpenCode/Claude peer round trip also passed again: one completed
fenced task, one native child, both messages acknowledged once, four emitted
tool calls across the hosts and one explicit Claude turn. Its task interval was
11,347 ms. The OpenCode root plus coordinator sampled 674,635,776 working-set
bytes; Claude's root sampled 218,750,976 bytes. Sampling Claude during its third
model request adds fixture overhead to that run, so use the earlier
[mixed-host campaign](../2026-09-22-mixed-host/README.md) for the unsampled timing.
The root samples are not a simultaneous aggregate or all short-lived subprocesses.

These are different tasks with different guarantees. Native-only returns a
child result in one host's session tree; it does not exercise Swarm's cross-host
identity, retained inbox acknowledgments, fencing or restart recovery. No speed
ratio is meaningful. Prefer the native route within a managed tree when those
independent-peer guarantees are unnecessary. The mixed route handles an actual
independently enrolled host, with its extra boundary and context costs explicit.

## Verification and reproduction

`verify-adapter-budgets.py` checks actual process counts/roles and summed memory,
matched hardware, the adapter memory budget, one native-only delegation, the
mixed task's single completed attempt, two acknowledged peer deliveries and
four emitted coordination tool calls. It passed against these retained files
and rejected a copy with adapter working sets increased fourfold. Typecheck
and all four final runtime commands exited zero. Raw checksums are retained.

```powershell
bun run build
bun scripts/measure-compact-context.ts 32 dist/test/redesign-memory.json
bun scripts/measure-mcp-context.ts 32 | Set-Content -Encoding utf8 dist/test/legacy-memory.json
bun scripts/probe-opencode-native.ts dist/test/native-only.json C:/Users/volpe/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe
bun scripts/probe-opencode-dispatch.ts dist/test/mixed-memory.json C:/Users/volpe/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe C:/Users/volpe/.local/bin/claude.exe
python scripts/verify-adapter-budgets.py --legacy dist/test/legacy-memory.json --redesign dist/test/redesign-memory.json --native dist/test/native-only.json --mixed dist/test/mixed-memory.json
uv run --with tiktoken==0.12.0 python scripts/count-host-context.py dist/test/native-only.json dist/test/mixed-memory.json
```

The local scripted endpoints exercise installed host machinery, not reasoning
quality. Token counts cover archived, lease-redacted JSON and exclude hidden
framing, inference and billing. Synthetic provider usage/cost fields are not
measurements. Broader platforms, arbitrary workloads and hosted CI are outside
this measured Windows campaign.
