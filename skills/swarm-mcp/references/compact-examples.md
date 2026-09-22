# Compact coordinator examples

These are tool arguments, not shell commands. Replace fixture IDs with values
from the current scope. Successful tools return `{data}`; mutations include
`data.value`, `data.cursor` and `data.replayed`. Check MCP `isError` first.

Resume with `swarm_sync` `{}`; later use `{"cursor": 42}` with the returned
`eventCursor`. Discover a task using `swarm_find` with
`{"kind":"task","taskId":"existing-task-id"}` before claiming it.

Create unassigned work with `swarm_assign`:

```json
{
  "commandId": "create-parser-fix-1",
  "title": "Fix parser edge case",
  "contract": {
    "objective": "Handle the reported empty input case",
    "worktree": "C:/worktrees/parser-fix",
    "acceptanceCriteria": ["Regression reproduces before the fix and passes after"],
    "expectedArtifacts": ["Commit and test evidence"],
    "constraints": ["Preserve existing nonempty-input behavior"]
  },
  "dependencies": []
}
```

Optional `routing` selects dispatch through the owner's existing policy, for
example `{"intentId":"parser-fix-1","capabilities":["code"],"durable":true}`.
A route can return blocked or uncertain; that is not permission to spawn again.
Dispatch currently does not accept dependency edges in the same assignment.
Create prerequisite work separately and dispatch only after it is ready.

For unassigned work, `swarm_task` claim:

```json
{"commandId":"claim-parser-1","action":"claim","taskId":"returned-task-id","expectedVersion":1}
```

The receipt's `data.value` contains `attemptId`, `fence`, `leaseUntil` and `task`.
Finish using the accepted attempt, including real evidence:

```json
{
  "commandId": "finish-parser-1",
  "action": "finish",
  "taskId": "returned-task-id",
  "attemptId": "returned-attempt-id",
  "fence": 1,
  "outcome": "completed",
  "report": {
    "summary": "Empty input handled",
    "evidence": ["Commit abc123; targeted regression passes"],
    "limitations": ["Integration review remains outstanding"]
  }
}
```

Fetch with `swarm_inbox`:

```json
{"commandId":"fetch-worker-1","action":"fetch","consumer":"worker-inbox"}
```

Read `data.value.deliveries[0]`; an empty array means no currently eligible work.
After processing, acknowledge its actual IDs:

```json
{"commandId":"ack-message-1","action":"ack","messageId":"returned-message-id","leaseToken":"returned-lease-token"}
```

Retry a lost response with the same command ID. The next logical fetch uses a
new ID; replaying an old fetch returns its earlier receipt. Runtime-delivered
envelopes already carry a lease, so they do not need a second fetch to process.

For a durable result, `swarm_wait` with `{"taskId":"returned-task-id","timeoutMs":30000}`
returns a terminal, timeout or interrupted result plus a resumable task reference.
Read current state and continue waiting by that task ID; don't recreate it.
