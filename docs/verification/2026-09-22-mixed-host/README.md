# Actual OpenCode / Claude round trip

Committed harness `da55211`, OpenCode 1.4.3, Claude Code 2.1.278, Node 22.14.0,
Bun 1.3.11, on the same Windows machine as the
[ring](../2026-09-22-benchmarks/README.md) and
[consumer](../2026-09-22-consumers/README.md) campaigns. Final captures record
an empty source diff and exact fixture/owner hashes. Typecheck passed.

Both installed hosts execute their normal tool and lifecycle machinery, with
isolated configuration and one shared temporary coordinator scope. Deterministic
local model endpoints select the fixture tool calls. No external inference ran;
this proves integration behavior, not reasoning quality or production model cost.

The coordinator dispatches one fenced task to an actual OpenCode native child.
The child automatically receives its assignment, asks the independently enrolled
Claude peer a question and acknowledges the assignment. The fixture then invokes
one explicit Claude user turn. Its native hook supplies the question; Claude's
actual MCP tools send a reply and acknowledge the question. OpenCode's automatic
delivery supplies the reply; its tool completes the original fenced task and
acknowledges the reply. SQL evidence checks the sender/recipient pair in both
directions, two acknowledged peer messages, one completed attempt and one child.

## Observations

- One completed task, no duplicate attempt or child; both peer messages acknowledged once.
- Task submission through observed completion: **10,248 ms** in this run.
- OpenCode: four model-endpoint requests, two emitted Bash tool calls. Each Bash
  call runs a fixed fixture helper containing two coordinator commands. Counts
  must not be presented as one underlying operation per tool call.
- Claude: three model-endpoint requests, two emitted MCP calls (`swarm_send`,
  `swarm_inbox` acknowledgment), **one explicit user-turn invocation**.
- Claude has no idle wake. The fixture's explicit invocation after the question
  persisted is an additional boundary requirement, not autonomous peer activation.
- No model-driven register, poll or heartbeat calls were needed for either host.

The existing OpenCode native-child dispatch probe also passes at the same commit:
one child, one completed attempt, two model requests, one emitted Bash call,
4,207 ms between task creation and completion. That fixture has no peer round
trip. It still uses Swarm for durable task state and acknowledgment: it is a
native-child route comparison, **not a native-only orchestration benchmark** or
an equivalent-latency comparison. A pure native comparison remains outstanding.

## Visible context accounting

Pinned tiktoken 0.12.0 with `o200k_base` counts JSON from the archived model
requests. Lease tokens were redacted before counting. These are counts of the
visible archive, not exact provider input tokens; repeated context is counted
again for each request. The raw count report separates messages, top-level
system and tools because the hosts encode these differently.

| Capture / host | Requests | Sum of message JSON tokens | First request's full host tool catalog tokens |
|---|---|---|---|
| Mixed / OpenCode | 4 | 12,387 | 10,930 |
| Mixed / Claude | 3 | 3,524 | 4,014 |
| Native child / OpenCode | 2 | 5,584 | 10,930 |

Claude additionally sent 17,322 top-level system tokens across its three
requests. OpenCode puts system content inside messages instead. Catalog counts
include native host tools; they are not the compact core-only schema budget.
The much smaller compact API capture must not be substituted for full host
context cost. `usage` and `cost` fields in Claude's output derive from synthetic
fixture responses and are explicitly **not measurements or charges**.

## Reproduce and remaining scope

```powershell
bun run build
bun scripts/probe-opencode-dispatch.ts dist/test/mixed.json C:/Users/volpe/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe C:/Users/volpe/.local/bin/claude.exe
bun scripts/probe-opencode-dispatch.ts dist/test/native-child.json C:/Users/volpe/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe
uv run --with tiktoken==0.12.0 python scripts/count-host-context.py dist/test/mixed.json dist/test/native-child.json
```

Executable paths are specific to this machine; pass the installed equivalents
elsewhere. The final two runs exited zero. The initial capture is retained as
`initial-nonzero.json`: the task completed, but the harness exited one after
trying to parse Claude's empty `HEAD /api/hello` request as JSON. Restricting the
fixture endpoint to `/messages` corrected that harness error before final proof.

Still unproven: native-only comparison, full adapter/host memory comparison,
general workloads beyond this deterministic exchange and complete automated
budget enforcement. VUH-1343 remains open; this capture is not a release gate.
