# Dispatch MCP verification

Actual Node owner and stdio clients, two-agent context capture; tokenizer:
`tiktoken==0.12.0`, `o200k_base`. See `token-counts.json` for exact catalog and
instruction counts. This counts explicit JSON/text, not hidden model framing or
provider billing. The capture measures catalog cost; it is not a model dispatch
benchmark.

`bun test coordination-mcp` separately exercises routed assignment, retry and
cancellation through modern and legacy MCP connections: 4 tests, 110 assertions.
The provider in that MCP regression is an existing fixture peer.

Reproduce:

```powershell
bun scripts/measure-compact-context.ts 2 dist/test/dispatch-context.json
uv run --with tiktoken==0.12.0 python scripts/count-context-tokens.py dist/test/dispatch-context.json
bun test coordination-mcp
```

## Installed OpenCode native dispatch

`opencode-native-dispatch.json` retains the actual OpenCode 1.4.3 run with an
isolated host database and production Node coordinator. Four dispatch calls
(three uncertain while enrollment was pending, then bound) created one child,
one attempt and one assignment. The plugin woke the child autonomously; the
native bash tool received its session capability through `shell.env`, published
the fenced result and explicitly acknowledged the assignment. The capture records
one completed attempt, one acknowledged delivery (one lease attempt), released
capacity and two requests to a local scripted model endpoint.

The first run stalled with a running task and pending, unleased inbox message:
new host sessions emitted creation without an initial status event. Creation now
establishes initial idle state without overwriting newer status or permission
evidence, and publishes availability after enrollment. Reconnect snapshot gating
still withholds delivery. The state regression covers those boundaries.

The fixture restarts its private owner to load native route configuration; the
recorded parent disconnection errors occur at that restart. Live configuration
is unchanged. This run verifies integration mechanics, not external inference,
model reasoning, native-to-peer handoff or non-cooperative termination.

Reproduce after `bun run build` (pass the installed native executable):

```powershell
bun scripts/probe-opencode-dispatch.ts dist/test/opencode-native-dispatch.json C:/Users/volpe/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe
```

The probe retains model requests and events on failure as well as success,
redacting captured delivery lease tokens. Fresh validation: 15 OpenCode tests,
118 assertions, TypeScript and production build pass.
