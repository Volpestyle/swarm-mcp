# Durable inbox contract

The coordination core stores version-one message envelopes and one delivery per
recipient. Envelopes contain a stable ID, sender, recipient, kind, body, optional
task/thread correlation, creation/expiry time, and the sender's command ID as an
idempotency key. Announcements snapshot an explicit, deduplicated recipient list
within the authorized scope. Offline recipients are valid.

`message.send` and `message.announce` atomically commit the message, deliveries,
event, and replayable command result. `inbox.fetch` leases eligible deliveries;
it never acknowledges processing. `inbox.ack` requires the current delivery token.
The sender can inspect all delivery dispositions through `message_status`; each
recipient can inspect only its own. `inbox` is a history snapshot, not a claim.

Retry a lost command response with the same command ID and payload. This returns
the original result, including fetch leases or an empty fetch. Use a new command
ID for the next logical fetch. A replayed fetch token can already be expired;
discard it and fetch again. An expired or superseded token cannot acknowledge a
new attempt. Repeated acknowledgment of an already acknowledged delivery with
its successful token is harmless, even under a new command ID.

Use `(message ID, recipient)` as the consumer deduplication key. Commit the
consumer's effect idempotently before acknowledging. If an effect succeeds and
the consumer crashes before acknowledgment, delivery can repeat. This is
at-least-once delivery within the configured retry/expiry policy, not exactly-once
external effects.

Unacknowledged messages have no default TTL and survive database reopening and
recipient inactivity. Explicit `ttlMs` ranges from one millisecond to 30 days.
Expired deliveries are never leased. Expiration records and lease recovery are
materialized by the recipient's next fetch or explicit `inbox.sweep`; an offline
recipient's snapshot can still say pending with an elapsed `expiresAt` until that
sweep. Rows remain visible; there is no one-hour deletion or legacy cleanup path
against this separate database.

Leases default to 30 seconds (maximum two minutes). Rejection or lease expiry
schedules exponential backoff, capped at one minute. Defaults are five attempts,
one-second initial backoff, and 1,000 active messages per recipient; the store
accepts validated policy overrides. Exhausted attempts become visible dead-letter
records. Retry policy is captured when a message is accepted. Healthy eligible
messages and independent recipients continue while another delivery backs off.
Announcement acceptance is atomic: a full recipient rejects the entire fanout.
Terminal history is retained; the active quota is not a total database size cap.

State changes and notification hints omit message bodies and lease tokens.
Service-provided authorization determines scope and actor, including when a
caller adds unexpected identity fields to its command.

## Compatibility and rollout

This module does not silently change legacy `poll_messages`. Existing consumers
still have legacy fetch-means-read behavior until the adapter/migration work in
VUH-1338 and VUH-1344. The durable API requires explicit acknowledgment; an old
consumer cannot be represented as having processed work merely because it polled.
Keep legacy and durable delivery modes explicit during migration, with no
automatic acknowledgment bridge. Session generations and supported resume are
supplied by VUH-1334; this layer retains deliveries under stable recipient IDs.

Verification: `bun test test/coordination-inbox.test.ts
test/coordination-core.test.ts test/coordination-ipc.test.ts` covers command replay,
explicit acknowledgment, stale token fencing, retention beyond one hour, expiry,
backoff/dead-letter state, fanout quotas, authorization, schema migration rollback,
and IPC. Separate Bun and Node workers exit after committed fetch/ack commands
before returning responses; eight simultaneous processes compete for one retained
delivery after the first consumer crashes.
