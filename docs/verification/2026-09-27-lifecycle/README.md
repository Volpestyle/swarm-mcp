# Follow-up to the September 26 local effectiveness audit

Implementation is based on `e60891b` plus the working-tree changes recorded here.
The lead Claude subagent had already fixed same-worker lease reclaim in that
commit. Its report also covered a separate Clankie workspace-link check. The
dead-on-arrival assignment incident was already addressed by the MCP-readiness
and fenced-claim work in `dff68e3`.

## Remaining findings addressed

| Finding | Change | Evidence |
| --- | --- | --- |
| Cancellation depends on an unavailable worker MCP | Creator cancellation writes a durable stop latch; the owned POSIX wrapper terminates its process group and publishes launch-bound proof. Release still requires proof. Full/stale inboxes cannot block provider stop. | Real wrapper/MCP integration kills the MCP, cancels, verifies the stopped receipt and released/cancelled state; process-group test includes a TERM-resistant descendant. |
| Cancelled work retains obsolete leased controls | On confirmed release, pending/leased assignment and cancellation envelopes expire with `dispatch_released`. Replies, results and dead letters are retained; no acknowledgment is invented. | Dispatch-runner and stream-worker tests check control expiry, reply preservation and retained-dispatch diagnostics. |
| Completed stream processes linger after release | Provider stop also latches teardown when a fenced terminal result supplies cooperative proof. Permanent exclusive start marker prevents duplicate launch. | The same launch-local stop path is exercised by integration and receipt identity tests. |
| Known long tool waits exceed the default progress window | Assignment contracts accept bounded `progressTimeoutMs`; initial dispatch and same-worker reclaim inherit it. Explicit claim overrides remain supported. | Native MCP assignment, durable task reopen and dispatch-rebind tests; invalid timeout validation; existing heartbeat/deadline tests stay intact. |
| Detached idle owners accumulate | Owner exits after five minutes without connected clients or pending requests; configurable or disabled with `idleTimeoutMs`. Retained identities/database survive retirement. | Actual Node owner survives a connected idle client, exits after disconnect and restarts with identical enrollment. Separate Node fixture verifies disconnected in-flight work prevents retirement. |
| Fast successful deliveries hide unresolved waiting | Diagnostics expose backlog age/count, expired leases, cancellation notices, retained task outcomes and bounded unreleased terminal/cancelling dispatches. | Scope/content-privacy diagnostics tests and cancellation lifecycle assertions. |
| Documented check fails under Bun | Package verifier resolves the actual npm JavaScript CLI instead of passing Bun's binary to Node. | `bun run check` completes package verification. |

## Verification

- `bun run check`: 198 Bun tests passed across 50 files, one Python hook test
  passed, TypeScript passed, production build passed, package verification passed.
- Fresh `bun scripts/measure-mcp-context.ts 32` capture checked with pinned
  `tiktoken==0.12.0`: catalog 2,712 tokens, instructions 115, maximum bootstrap
  132, unrelated-event delta 10. All context budgets pass; manual handoff remains
  three calls per agent. This is protocol/token accounting, not billed model cost.
- `git diff --check` passed.

An initial package check failed because `npm_execpath` named Bun's native binary;
the resolver fix above addresses it. An added idle-time test initially ran the
owner under Bun and hit a Unix socket probe error; its fixture now runs under the
production Node runtime. No production claim is made for a Bun-owned server.

## Deployment and evidence boundaries

No live owner, worker, pane, database or installed Clankie package was replaced or
stopped. Clankie still needs the tested package vendored and a coordinated runtime
rollout. Existing wrappers do not understand the new stop latch; missing/legacy
termination receipts remain uncertain. Do not release their capacity based on
age, a missing pane, or lease expiry. Windows also retains the cooperative-proof
path; the new process-group termination test was run on macOS. Independently
detached external jobs need their own provider termination contract.

The progress window still defaults to 15 minutes. The lead must select a longer
contract timeout for known long operations; heartbeats do not imply progress.
Outstanding ordinary replies are surfaced, not discarded or automatically
acknowledged. Owner idle retirement prevents new accumulation; this audit did not
clean up old evaluation owners.

Net productivity and model-cost savings remain unmeasured. Reviewed outcomes,
rework, human intervention and matched single-agent comparisons are still needed;
the local completion fraction and transport benchmarks cannot establish them.
