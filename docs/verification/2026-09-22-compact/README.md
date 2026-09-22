# Compact API context measurements

## Final common API catalog

`compact-native-envelope-2.json` retains the nine tools and typed successful
outputs while using MCP `isError` instead of repeating an ok/data/error schema.
Identifier/text bounds appear once in server instructions; runtime validators
still enforce them, tested through modern and legacy clients with overlong
command IDs and titles. Successful results use `{data}`; failures use `{error}`.

The catalog is **2,925 tokens**, plus **73 instruction tokens = 2,998**. This
meets the 3,000-token gate even when counting the common instructions. Bootstrap
text is 31 tokens per agent in the empty-task fixture. It uses one model call
instead of legacy register + bootstrap; trusted enrollment occurs outside the
model. The full send/fetch/ack workflow remains four calls per agent, preserving
explicit acknowledgment rather than claiming a total handoff-call reduction.

Earlier captures below document intermediate designs and are not final figures.

Final validation: TypeScript and build passed. Focused schema/modern/legacy tests
passed (4 tests, 98 assertions). `full-suite.log` records 283 passing and 38
failing tests, 1,202 assertions, 321 tests across 26 files. The normalized failure
names match the prior MCP-v2 Windows baseline exactly; the full suite is not
green. Both logs repeat failures in their final summary.

| VUH-1338 requirement | Evidence |
| --- | --- |
| Common bootstrap/discovery/task/message/wait path | `docs/compact-api.md`; real modern/legacy adapter workflows |
| Structured outputs, errors and annotations | `mcp-output.ts`; schema tests and real conflict/invalid-bound calls |
| Task contracts, ownership, completion evidence | Task persistence tests and normalized owner/contract reads in MCP tests |
| Targeted bounded data, stable prefix | Query tests, receipt rollback and byte-page cursor tests; captured instructions |
| Typed correlated messages distinct from assignments | Real send/fetch/ack workflow with kind/thread/task fields |
| Existing callers and migration mapping | Retained legacy adapter; `docs/compact-api-migration.md` maps all 33 names and unsupported equivalences |
| Reduced calls/context with delivery guarantees | One-call bootstrap vs register + bootstrap; captured token counts; separate explicit ack retained |
| Async dispatch and resumable bounded wait | Task timeout/interruption/completion-race tests, IPC disconnect/reconnect, task-resource read after timeout |

The compatibility path preserves existing callers on their original adapter;
it does not translate between stores. Runtime auto-enrollment/delivery, native
routing and live cutover remain in VUH-1339/1340/1344 respectively.

## Output-schema follow-up

`compact-schema-2.json` captures the later catalog with receipt/page/bootstrap,
task ownership, shared-key and wait output schemas. It measures **4,040 catalog
tokens**, 1,016 call argument/text tokens, and 9,096 including catalogs for two
agents. The catalog remains below the legacy 6,042 tokens but fails the 3,000
target. The measurements below describe the earlier envelope-only catalog;
they are retained as historical evidence, not the final budget result.

The current schemas describe stable result structure while leaving variable
command values and page entries extensible. Both modern and legacy real MCP
workflows pass, including reading the task URI returned by a timed-out wait.

## Initial envelope-only measurements

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
