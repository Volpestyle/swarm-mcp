# May 1st Slice 7A Stale Reconciliation QA

Use this when checking stale/offline cleanup and phantom-row behavior.

## Setup

1. Open `swarm-ui`.
2. Use a channel with at least one stale/offline instance row or create one by killing an agent process outside the UI.
3. Optional hard-mode check: remove an instance row directly from `~/.swarm-mcp/swarm.db` while the UI is open.

## Pass/Fail Cues

1. Watch the status bar counts.
   - Pass: active/stale/offline counts match the visible rows.
   - Fail: a removed row keeps counting until Cmd+R.
2. Click stale/offline cleanup for the channel.
   - Pass: the visible stale/offline rows disappear immediately.
   - Fail: cleanup succeeds in the backend but the UI row remains.
3. Click `kill all` on a channel with visible rows.
   - Pass: rows that the backend killed or reports as already gone disappear from the UI.
   - Fail: the UI leaves a phantom active row after the backend has no matching instance.
4. Inspect task rows assigned to the removed instance.
   - Pass: claimed/in-progress tasks return to `open`; blocked/approval-required tasks keep status but clear assignee.
   - Fail: a removed agent still appears to own active work.
5. Inspect locks/messages.
   - Pass: locks and queued recipient messages for the removed instance disappear.
   - Fail: removed agents still hold locks or unread queued messages.
6. Try removing a row that was already deleted in the DB.
   - Pass: the UI treats `instance not found` as local cleanup success.
   - Fail: the row is stuck behind a not-found error.
