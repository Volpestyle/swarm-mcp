# Phase 2 Acceleration Tooling Manual QA

1. Run `swarm-mcp ui export-layout --wait 0 --json`.
Expected: a UI command row is returned with a command id.

2. Open the UI and trigger layout export from Settings.
Expected: an export path is shown, or a clear error is shown.

3. Trigger screenshot capture from Settings.
Expected: a screenshot path is returned, or the unsupported capture error is visible.

4. Run `swarm-mcp ui screenshot --wait 0 --json`.
Expected: a UI command row is returned with a command id.

5. Attach the exported file path to a swarm task.
Expected: another agent can inspect the exported state without asking the user to describe the UI.
