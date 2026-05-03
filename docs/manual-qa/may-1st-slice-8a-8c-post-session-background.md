# May 1st Slice 8A-8C Manual QA

Scope: Project Page `Post-Session Improvement`, bounded background launch, and background Resume Center.

Use the installed/Tauri app for launch, suspend, kill, close/reopen, and native notification proof. Browser/Vite is acceptable only for layout and survey-only save checks.

## 8A Survey-Only Save

1. Open `Workspace Kit` or any saved project.
2. Scroll to `Post-Session Improvement`.
3. Fill `Worked`, `Confusing`, `Broke or unreliable`, choose `Improve next`, and enter a follow-up prompt.
4. Leave `Work on this while I am away` unchecked.
5. Click `Save review`.

Pass:

- A success message says the post-session note was saved.
- If `Create improvement task` is checked, a `Post-session improvements` row appears in Task Board.
- No PTY opens and no background agent launches.

Fail:

- The app launches an agent without explicit background opt-in.
- The note saves without visible feedback.
- The Task Board row overlaps controls or cannot be edited.

## 8B Bounded Background Launch

1. Fill the same review fields.
2. Check `Work on this while I am away`.
3. Confirm provider, role, trust posture, timeout, and idle policy.
4. Click `Save + launch bounded agent`.
5. Read the confirmation carefully, then confirm only if the cwd, internal channel, trust posture, timeout, and idle policy are correct.

Pass:

- Empty prompt, invalid timeout, or missing idle policy blocks launch with a clear error.
- Full access shows a dangerous/red confirmation.
- The launched row records background run/result details.
- The agent bootstrap includes project, run id, timeout, idle policy, and no commit/push/delete/destructive-cleanup guardrails.

Fail:

- The app opens a PTY before confirmation.
- Full access is not called out.
- The agent starts without project/task/background labels.

## 8C Resume Center

1. After launch, stay on the same project page.
2. Confirm `Resume Center · Background Work` lists the run.
3. Click `Suspend`.
4. Confirm the agent receives a direct control message asking it to report status and enter `wait_for_activity`.
5. Click `Kill`.
6. Confirm the destructive dialog appears, then kill the run.

Pass:

- Resume Center shows status, provider, role, timeout, and scope.
- Suspend does not kill the process.
- Kill uses the real kill/deregister path and the row disappears after reconciliation.

Fail:

- Resume Center shows stale rows that do not reconcile.
- Suspend broadcasts to the wrong project/scope.
- Kill only removes the UI row while the process keeps running.

## 8D Follow-Up Checks

Run after 8A-8C are stable:

- Close and reopen the app with a background run active; Resume Center should still reflect the live/stale/offline truth.
- Decide whether timeout and idle policy stay prompt-level for MVP or need app-enforced timers.
- If native notifications are added, verify only explicit background statuses notify: completed, failed, approval needed, stale, or timed out.
