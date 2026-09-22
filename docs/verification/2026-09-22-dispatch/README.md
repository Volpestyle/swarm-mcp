# Dispatch MCP verification

Actual Node owner and stdio clients, two-agent context capture; tokenizer:
`tiktoken==0.12.0`, `o200k_base`. See `token-counts.json` for exact catalog and
instruction counts. This counts explicit JSON/text, not hidden model framing or
provider billing. The capture measures catalog cost; it is not a model dispatch
benchmark.

`bun test coordination-mcp` separately exercises routed assignment, retry and
cancellation through modern and legacy MCP connections: 4 tests, 110 assertions.
The provider is an existing fixture peer; native model-host provisioning remains
unverified.

Reproduce:

```powershell
bun scripts/measure-compact-context.ts 2 dist/test/dispatch-context.json
uv run --with tiktoken==0.12.0 python scripts/count-context-tokens.py dist/test/dispatch-context.json
bun test coordination-mcp
```
