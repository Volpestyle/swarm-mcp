# MCP v2 compatibility (candidate)

The stdio entry uses `@modelcontextprotocol/server` 2.0.0 with `serveStdio`
and explicit `legacy: "serve"`. The application identity remains separate from
protocol negotiation. The existing application handlers are transitional; the
compact coordinator-backed API is tracked in VUH-1338.

## Verified matrix

`test/mcp-protocol.test.ts` launches the real entry with disposable databases.
The SDK 2.0.0 client is tested in both legacy-handshake mode and pinned
2026-07-28 mode. Both discover tools/resources/prompts, register an application
session and read its inbox. Raw modern results carry `resultType`, server identity
and private cache hints; legacy results omit modern-only fields.

Task-resource subscriptions deliver the selected resource, stop after unsubscribe,
and permit cancellation of an active activity wait. Disconnect stops instance
timers and closes the serving handle; stdin EOF is handled explicitly because the
SDK transport does not itself bind EOF to close. Tests require client closure
before its forced-termination fallback. Subscriptions are capped at 16 per modern
connection; the legacy URI set has three supported resources. Activity waits have
a 60-second maximum and a 30-second default (including legacy zero values).

Resource values have private, zero-TTL caching. Stable tool/resource/prompt
catalogs and discovery use private 60-second caching. The SDK supplies wire
envelopes; application callbacks do not hand-assemble protocol-only fields.

These subprocess tests do not establish installed Codex, Claude, Hermes or
OpenCode host support, or that receiving a notification wakes a model. Runtime
delivery and wake behavior are separate VUH-1339 acceptance checks. Inbox-specific
notification and raw negotiation/error coverage remain open in VUH-1337.

## Tasks extension decision

The [MCP Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks)
models deferred results of tool calls, negotiated through the
`io.modelcontextprotocol/tasks` capability. It does not supply Swarm's worker
ownership, attempt fences, dependencies or file reservations.

Do not advertise this extension in the current adapter. Coordination commands
return durable acceptance promptly; agents retrieve application task state through
the Swarm API. A future genuinely long-running tool may add a separate negotiated
extension handle linked to the application attempt. It must persist acceptance
before returning a handle and define how protocol cancellation maps to cooperative
application cancellation. Merely renaming Swarm tasks into protocol tasks would
conflate two different lifecycles.

Serving reference: [official stdio guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md).
