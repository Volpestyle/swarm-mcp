# Inbox verification

Windows, Bun 1.3.11, Node 22.14.0. The tests run against isolated temporary
databases; the configured legacy database and server remain unchanged.

`bun test test/coordination-inbox.test.ts test/coordination-core.test.ts
test/coordination-ipc.test.ts`: 31 passed, zero failed, 154 assertions.
`bunx tsc --noEmit`: passed.

`bun test`: 222 passed, 38 failed, 684 assertions. [Retained full log](full-suite.log).
The normalized failed-test names exactly match the 38 recorded in the
[core baseline](../2026-09-21-core/full-suite.log). These are existing Windows
subprocess/environment failures, not a green full suite.

The inbox suite exercises real subprocess exits after committed fetch/ack but
before returning a response, independently under Bun and Node. Retry reads the
same durable command result. Eight competing processes acquire one replacement
lease after the original consumer dies; expired tokens cannot acknowledge it.
The migration test starts at schema one with a retained task, interrupts migration,
verifies version one and absent inbox tables, then reopens successfully and sends.

The IPC test sends, fetches, acknowledges, and reads disposition through a Node
owner with a Bun client. Unit scenarios cover old-message retention, announcements,
scope isolation, quotas, retries, dead-letter state, explicit expiry, and the
regression where unexpected command properties overrode trusted identity.

See [the API and compatibility contract](../../durable-inboxes.md). Lifecycle
integration and migration of legacy consumers remain separate delivery tickets.
