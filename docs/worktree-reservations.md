# Worktree ownership and reservations

Use isolated Git worktrees for substantial parallel changes. Assign one session
to integrate a change set, and reserve integration ownership for the target
checkout before merging. Shared checkouts are appropriate for small, explicitly
coordinated edits with a declared write set. Different profiles should use separate
checkouts/databases; reservations are scoped to the trusted project/profile.

The launcher discovers the worktree root and common Git directory, then binds
them to the enrolled session. Clients cannot choose another checkout in a command.
File acquisition resolves relative paths, real symlink ancestors (including new
files), and Windows case folding. Paths escaping the checkout, dangling symlinks,
directories, `.git` metadata and Windows alternate data streams are rejected.

Physical reservations identify a canonical file in one checkout. Logical overlap
identifies the common Git repository plus relative path. Two worktrees can edit
the same relative file concurrently; the response warns about the other owner.
That warning calls for review at integration, not serialization of independent
checkouts.

## Grant contract

`reservation.acquire` accepts file paths or integration ownership, a reason, and
an optional task attempt ID. The service sorts and deduplicates the write set,
then checks and acquires it atomically. A conflict acquires no partial set and
returns the owner, reason, age, expiry, fence and recovery guidance. There is no
indefinite wait or multi-resource deadlock. Use a new command ID to retry a denied
acquisition; replay returns the original denial.

Each grant has an immutable ID, increasing fence, session generation and expiry.
Leases default to 60 seconds, with a five-minute maximum per renewal, and never
outlive an attached task lease. `reservation.check`, `renew` and `release` require
the current owner and exact grant/fence. An expired or superseded holder cannot
modify a replacement. Acquisition recovers invalid holders transactionally;
`reservation.sweep` provides explicit cleanup and retained recovery events.

An operation in the same session may reuse an enclosing grant. The response
separates `grants` acquired by this operation from `reused` grants: release only
the former. Check both before writing. Replaying an acquisition is not a new lease.

Integration ownership is exclusive across a repository's worktrees. It also
conflicts with other sessions' file reservations in the target checkout, and
blocks new peer file reservations there. Other worktrees remain available for
ordinary edits. Git metadata changes must go through the integration critical
section; they are not ordinary file reservations.

## Hook and critical-section wiring

After trusted session enrollment, the launcher supplies:

- `SWARM_COORDINATOR_ENDPOINT`: local owner pipe/socket.
- `SWARM_SESSION_CAPABILITY`: this incarnation's capability.
- `SWARM_COORDINATOR_CLIENT`: JSON argv array, for example
  `["node", "C:/path/to/dist/coordination/client-cli.js"]`.
- Optional `SWARM_TASK_ATTEMPT_ID` for task-bound write grants.

`bun run build` produces the client; the package exposes it as
`swarm-coordinator-client`. The helper reads an operation from stdin and returns
JSON over stdout. It never prints credentials. Trusted runtime launchers supply enrollment; the variables do not initialize or
convert a database.

The shared pre-tool hook acquires all recognized paths, checks current grants,
and denies the write if acquisition or validation fails. An enabled hook also
denies missing path metadata or stable tool-call IDs. PostToolUse releases its
new grants. Lost post events leave bounded leases for recovery. Missing enrollment
denies known writes. Relative file paths use the host process working directory.

Wire `PreToolUse` and `PostToolUse` to the corresponding `pre_tool_use.py` and
`post_tool_use.py` in `integrations/claude-code/hooks` or `integrations/codex/hooks`,
using the absolute Python executable and script paths in native host settings.
Keep the checkout layout so the scripts can locate `integrations/_shared`.
These hooks own reservations only; the runtime adapter owns session lifecycle.

For multi-step shell edits and Git integration, run
`python integrations/_shared/leased_command.py --kind integration --reason
"integrate reviewed change" -- git merge --ff-only <revision>` from the enrolled
checkout. For file work, pass `--kind file --paths '["a.ts","b.ts"]'`. The wrapper
acquires/checks before starting its subprocess, renews during execution, terminates
the direct child on lost ownership, and releases its grants on exit. It does not
renew the task lease; the runtime adapter owns that responsibility.

## Coverage and limits

| Write path | Coverage in this change |
| --- | --- |
| Claude-style Write/Edit/MultiEdit/NotebookEdit | Recognized path fields; atomic pre-acquisition and post-release. |
| Codex-style apply_patch hook payload | Add/update/delete and both rename forms; entire patch write set acquired together. |
| Explicit leased_command subprocess | Cooperative critical section with renewal and direct-child termination on loss. |
| Arbitrary shell, Python, terminal or editor writes | Uncovered unless explicitly wrapped. No shell-command guessing. |
| Nested tool calls or unrecognized tool names | Uncovered unless the host emits a supported write event. |
| Other hosts | Require a trusted reservation integration before claiming write coverage. |
| Actual Claude/Codex hook delivery | Subprocess contract tested here; installed-host lifecycle validation belongs to VUH-1339. |

These are cooperative reservations, not kernel filesystem locks. A host that does
not emit/enforce hooks can bypass them. A single host write outliving its lease,
OS suspension, symlink retargeting after the check, hard-link aliases, and detached
descendants of a wrapped shell command are not universally fenced. Use isolated
worktrees to contain those gaps; never advertise universal filesystem enforcement.
Long-running critical sections should use the renewing wrapper rather than relying
on a pre-tool lease alone.
