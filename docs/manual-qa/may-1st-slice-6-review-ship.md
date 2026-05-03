# May 1st Slice 6 Review/Ship QA

Use this when checking the Project Page after task rows have results.

## Setup

1. Open `swarm-ui`.
2. Open a saved project with at least one task row tied to the project root.
3. Prefer one completed row with `files_changed` in the result, one row with tests/verification text, and one failed or blocked row for risk display.

## Pass/Fail Cues

1. Open the Project Page.
   - Pass: `Review / Ship` appears below `Files`.
   - Fail: shipping output is still only scattered through task rows.
2. Inspect the top metrics.
   - Pass: file count, risk count, and `explicit commit only` are visible.
   - Fail: the surface implies an automatic commit or push.
3. Inspect `Commit suggestion`.
   - Pass: suggested text includes the project name and task/result context.
   - Fail: the message is blank or generic when task results exist.
4. Click `Copy commit message`.
   - Pass: the status line says `Commit message copied.`
   - Fail: clipboard errors are shown silently or no status appears.
5. Click `Copy review task`.
   - Pass: the status line says `Review task prompt copied.`
   - Fail: the reviewer prompt cannot be copied.
6. Inspect `Unresolved risks`.
   - Pass: failed, blocked, cancelled, approval-required, or result-reported risks appear here.
   - Fail: risky task states are hidden from the ship surface.
7. Inspect `Changed / review files`.
   - Pass: files are grouped with task titles and agent labels when available.
   - Fail: files are missing even though task rows reported changed files.
8. Inspect `Task result summaries`.
   - Pass: each linked task shows status, summary, agent, and test status.
   - Fail: completed task results are not represented.
9. If an online reviewer/opencode agent is attached to the project, click `Ask reviewer`.
   - Pass: the status line says the review handoff was sent to that reviewer.
   - Fail: the button is enabled without a reviewer, or the handoff uses the wrong project channel.
