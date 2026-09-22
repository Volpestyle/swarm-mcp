# Compact API context measurements

Actual stdio MCP adapters against a separate Node coordinator, with disposable
databases and 2 or 32 independently enrolled sessions. Each agent bootstraps,
sends to its next peer, fetches the previous peer's message, verifies its body,
and explicitly acknowledges processing. No live database is involved.

Reproduce from the repository root:

```powershell
bun scripts/measure-compact-context.ts 2 dist/test/compact-context-2.json
bun scripts/measure-compact-context.ts 32 dist/test/compact-context-32.json
uv run --with tiktoken==0.12.0 python scripts/count-context-tokens.py dist/test/compact-context-2.json dist/test/compact-context-32.json
```

| Measurement | 2 agents | 32 agents |
| --- | ---: | ---: |
| Model-visible calls | 8 | 128 |
| Catalog tokens per agent (9 tools) | 3,001 | 3,001 |
| Bootstrap text tokens per agent | 40 | 40 |
| Call arguments + text results | 994 | 16,140 |
| Including one catalog per agent | 6,996 | 112,172 |

The legacy catalog was 6,042 tokens across 33 tools. The compact catalog is
50.3% smaller but still exceeds the 3,000-token budget by one token, before
remaining output-schema changes. The two-agent legacy run used 2,534 call
tokens and 14,618 including catalogs; these fall by 60.8% and 52.1% respectively.

Both versions use four calls per agent in this comparison. Compact bootstrap
combines discovery of existing session state in one model call; trusted runtime
enrollment occurs beforehand. Explicit processing acknowledgment adds a call to
message delivery. Legacy register/bootstrap/send/poll did not provide that
acknowledgment guarantee. This is evidence of reduced tokens, not reduced total
handoff calls. Host delivery integration remains separate work.

The tokenizer counts JSON call arguments and text results once. Structured
content duplicates the text envelope; hosts that include both consume more.
These figures exclude hidden framing, inference, reasoning, cache treatment,
and provider billing. Random identifiers can slightly change token counts.
Bootstrap was measured before creating tasks; this is not a loaded-task payload
bound. Payload caps and precise output schemas remain open under VUH-1338.

Validation: TypeScript checking passed; actual modern and legacy MCP workflow
tests plus notification filtering passed (3 tests, 80 assertions).
