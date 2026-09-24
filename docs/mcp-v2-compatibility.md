# MCP transport compatibility

The coordinator uses MCP SDK 2.0.0 `serveStdio` with `legacy: "serve"`.
Modern 2026-07-28 negotiation and the legacy MCP handshake both expose the same
nine-tool [Swarm API](api.md). Transport compatibility does not select a different
application API, database or authorization model.

`test/coordination-mcp.test.ts` exercises both protocol modes against a real Node
owner: discovery, authenticated task/message operations, schemas, resource
subscriptions, cancellation and disconnect. Modern clients use `subscriptions/listen`;
legacy clients use resource subscribe/unsubscribe. Resource changes are hints to
read durable state, never evidence that a model processed a message.

The adapter bounds concurrent waits to eight and subscriptions to sixteen.
Cancelling a tool request releases its wait connection without cancelling the
application task. Adapter shutdown closes its client, observer and wait sockets.

The optional MCP Tasks extension is not advertised. Swarm task ownership,
attempt fences and cooperative cancellation belong to the application contract;
a transport task handle does not supply those guarantees. Host lifecycle and
automatic delivery support are documented [separately](runtime-host-support.md).
