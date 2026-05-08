# May 1st Slice 5 Proof Pack QA

Use this when reviewing the first Project -> Task Board -> task-bound agent loop.

## Project Task Board

1. Open swarm-ui and choose a saved project.
   - Pass: the Project Cockpit opens without asking for scope/channel decisions.
   - Fail: the first useful action requires manual scope/channel setup.

2. Paste three short plan bullets into `Paste plan into task rows`, then click `Import plan rows`.
   - Pass: three editable rows appear and are selected.
   - Fail: rows are missing, duplicated, or text does not fit the row controls.

3. Keep provider as `Codex`, role as `Implementer`, and click `Launch 3`.
   - Pass: each row records listener state plus agent or PTY identity.
   - Fail: a launched row has no agent id and no PTY id, or the row gives no launch error.

4. Add a short `Review note`, then click `Capture proof pack`.
   - Pass: a message shows a saved `swarm-ui-proof-pack-*.json` artifact path.
   - Pass: if screenshot capture is unsupported, the message and artifact say so plainly.
   - Fail: capture throws an unstructured Tauri error or writes no artifact.

## CLI Sidecar

1. Run `swarm-mcp ui proof-pack --scope <project-scope> --note "slice 5 smoke" --wait 0 --json`.
   - Pass: the command is queued as `ui.proof-pack`.
   - Fail: CLI reports an unknown subcommand or unknown UI command kind.

2. If the UI worker is running, inspect the command result with `swarm-mcp ui get <id> --json`.
   - Pass: result contains `ok: true` and a proof-pack artifact path.
   - Pass: CLI-created artifacts warn that DOM evidence requires the in-app button.
   - Fail: command remains failed because `ui.proof-pack` is unsupported.

## Native Worker Smoke

Use this when proving the Tauri worker, app-owned PTY, and Codex adoption path without relying on browser-mode mocks.

1. Launch the native debug app, then queue a task-bound Codex spawn with `swarm-mcp ui spawn <project-root> --harness codex --role implementer --label "project:<id> task:<id> source:project_task_board" --scope <project-scope> --wait 15 --json`.
   - Pass: result contains an `instance_id`, `pty_id`, and `role`.
   - Fail: command stays pending/failed, or returns no bound instance.

2. Let the frontend wrapper-script path type the Codex launch command, or use an equivalent short `zsh <script>` prompt if driving from CLI.
   - Pass: the instance row becomes `adopted=1` with a nonzero pid.
   - Pass: daemon `/state` shows the PTY bound to the same instance with `exit_code: null`.
   - Fail: direct long command text leaves the shell unadopted or stuck in quote-continuation mode.

3. Verify the agent sends a standby message and enters the wait loop.
   - Pass: `messages` contains the expected standby marker.
   - Pass: `events` contains `instance.registered`, `message.broadcast`, and `agent.waiting` for the instance.
   - Fail: the process exists but never registers or never broadcasts.

## Native Click-Through

Use this when proving the actual human-visible Project -> Task Board path inside the native app.

1. Confirm macOS can click the app.
   - Pass: the active controller has System Settings -> Privacy & Security -> Accessibility enabled.
   - Fail: click automation reports `-25211`, or a controller opens Accessibility settings instead of clicking `swarm-ui`.

2. Open the native debug app and click `Workspace Kit`.
   - Pass: the saved project list or project picker opens.
   - Fail: Home stays visible with no response, or another app receives the click.

3. Open the saved `swarm-mcp-lab` project, then scroll to `Task Board`.
   - Pass: `Project Cockpit`, `Task Board`, `Agents`, and `Recent Activity` are visible without scope/channel setup.
   - Fail: the path lands on Advanced Launch or requires manual protocol fields before work can start.

4. Import three task rows, click `Launch 3`, then click `Capture proof pack`.
   - Pass: rows show listener/task identity and the proof-pack path is visible.
   - Fail: launched rows lack agent or PTY identity, or proof capture fails without a structured message.

Slice 5C note from 2026-05-02: native screenshot capture produced `/tmp/swarm-5c-proof/native-home.png`, but automated clicks were blocked by Accessibility before the Task Board path could be completed.
The retry attempt produced `/tmp/swarm-5c-retry/native-home.png` and hit the same `-25211` Assistive Access failure.

Slice 5E note from 2026-05-02: the current native bundle rebuilt and screenshot capture produced `/tmp/swarm-5e-proof/native-home.png`, but the native click path still stopped at macOS Assistive Access (`-1719` on the latest attempt). Treat full native click automation as sidelined until the end-of-overhaul revisit; it is not blocking the next product slice because native worker/PTY/adoption proof already passed in Slice 5B.

## Retry / Reassign Rows

Use this when proving Slice 5D task-row recovery.

1. Create or import three Task Board rows.
   - Pass: each row shows `Retry`, `Reassign`, and `Reset` in the result column.
   - Fail: failed or launched rows require editing hidden state before recovery actions are visible.

2. Force one failed or stale row, then click `Retry`.
   - Pass: the row relaunches through the same task-bound path and keeps provider, role, task title, task id, and project channel.
   - Pass: if the launched instance is missing or offline, the row shows `stale` state and the missing/offline reason.
   - Fail: retry silently clears task identity, launches without project/task labels, or leaves no row-level error.

3. Change the bulk provider/role, then click `Reassign` on the stale row.
   - Pass: provider/role updates, stale launch identity clears, the row stays selected, and listener state reads ready/reassigned.
   - Fail: stale agent id remains attached, or the row is no longer selectable for relaunch.

4. Click `Reset` on a launched or failed row.
   - Pass: assignee, agent id, PTY id, launch error, and stale listener state clear while the task text remains intact.
   - Fail: reset deletes task text or hides the row from the launch selection.

## Slice 5E Acceptance Sweep

Use this when deciding whether Slice 5 is safe enough to continue past native click automation.

1. Rebuild or relaunch the current debug bundle.
   - Pass: `target/debug/bundle/macos/swarm-ui.app` opens and screenshot capture shows the current Home surface.
   - Fail: the bundle is stale, cannot launch, or screenshot capture cannot prove which surface opened.

2. Try native click automation once.
   - Pass: native click-through reaches Task Board and can run the Project -> Task Board checklist above.
   - Acceptable blocked state: macOS returns Assistive Access/TCC denial, and no UI command or instance state changes as if the click succeeded.
   - Fail: automation partially clicks the wrong app or mutates swarm state without visible proof.

3. Run the browser visual proof path.
   - Pass: Home -> Workspace Kit -> saved project -> Task Board -> import three rows -> `Launch 3` -> `Retry` one stale row -> `Capture proof pack` -> `Reassign` one row.
   - Pass: screenshots include launched rows, retry state, proof-pack message, reassign state, and one narrower viewport pass.
   - Fail: controls overlap task rows, row text becomes unreadable, or retry/reassign is unavailable after stale/missing-agent state.

4. Check proof evidence.
   - Pass: 3 rows, 3 `Retry`, 3 `Reassign`, 3 `Reset`, stale missing-agent copy, 4 mocked `spawn_shell` calls, proof-pack `rowCount: 3`, `launchedRows: 3`, `taskBoundRows: 3`, `screenshot-unavailable`, semantic snapshot count 80, and scroll-container count 2.
   - Pass: if the native screenshot path is blocked, the proof pack says so plainly and still includes semantic evidence.
   - Fail: proof-pack rows lose project/task identity, omit stale launch truth, or report success without screenshot/semantic evidence.
