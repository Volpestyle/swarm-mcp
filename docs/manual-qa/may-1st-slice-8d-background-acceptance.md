# May 1st Slice 8D Manual QA

Scope: native background-work acceptance for bounded launch, suspend control, kill cleanup, and timeout/notifier decision.

Date: 2026-05-02 local runtime.

## Result

Status: native background-control loop accepted; human-visible installed click/reopen remains follow-up.

Decision: timeout and idle enforcement remain prompt-level for MVP. App-enforced timers and native notifications are post-MVP follow-up, and any notification path must only fire for explicit background statuses: completed, failed, approval needed, stale, or timed out.

## Native Worker Smoke

Commands exercised:

- `swarm-mcp ui proof-pack` command `#16` wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777768335607.json`.
- `swarm-mcp ui proof-pack` command `#17` wrote `/Users/mathewfrazier/.swarm-mcp/artifacts/swarm-ui-proof-pack-1777768343310.json`.
- `swarm-mcp ui spawn` command `#19` created background run `bg-8d-native` as instance `6b7ea64b` with PTY `ff7eeb7d`.
- `swarm-mcp ui prompt` command `#20` launched the guarded Codex prompt.
- Event `#920` adopted `6b7ea64b` with pid `88210`.
- Message `#308` delivered the suspend control with sender `operator:/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`.
- Events `#924` through `#926` show the agent polled one unread message, returned from `wait_for_activity` on `new_messages`, then re-entered waiting.

Pass:

- Background run labels included `owner:background-work`, `background_run`, `timeout_m`, `trust`, `source:post_session_review`, and `slice:may_1_s8`.
- Suspend was a direct control message, not a broadcast.
- The smoke prompt explicitly blocked repo inspection, tests, edits, commit, push, delete, rewrite history, and cleanup.

## Kill Regression And Fix

The first native kill command exposed a real backend bug:

- Command `#21` deregistered the smoke row but returned `note: "Protected swarm-server process"` and no terminated pid.
- Root cause: `kill_target_internal` checked protection against the whole process table instead of the target process group, and UI-bound PTYs were only closed when the registered pid was zero.

Fixes:

- Added `swarm-mcp ui kill --target <instance>` acceptance command.
- Added native worker support for `kill_instance`.
- Updated `kill_target_internal` to close bound PTYs first, check only the target process group for protection, and treat clean post-PTY deregistration races as success.

Final proof:

- Command `#27` completed with `closed_ptys: ["7fe78ef1-8ae2-45dd-9048-a6ea2baa63c4"]`.
- Command `#27` completed with `deregistered_instances: ["f8956e86-f834-4104-b131-ae8f012bd98f"]`.
- Command `#27` completed with `terminated_pids: [96058]`.
- `swarm-mcp instances --scope /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul --json` returned `[]` after cleanup.
- Process search found no `bg-8d-native`, `bg-8d-killfix`, or `bg-8d-killdone` smoke process after cleanup.

## Open Follow-Up

- `bunx tauri build --debug` still hit the packaging-specific `tauri` rlib artifact issue, while direct `cargo build --bin swarm-ui` passed.
- `swarm-mcp ui screenshot` returned `window screenshot capture unavailable in this runtime`.
- A human-visible installed-app run still needs to click through save review, create task, close/reopen, and Resume Center truth.
