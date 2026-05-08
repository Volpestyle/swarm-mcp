# May 1st Slice 7B/7C Manual QA - Launch Preflight And Trust Posture

Scope: `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`

Goal: prove bad commands block before spawn, valid commands launch, and full-access posture is visible.

## Setup

1. Start the dev app or installed debug app.
2. Open `Workspace Kit`.
3. Open `/Users/mathewfrazier/Desktop/swarm-mcp-lab`.
4. Go to the Project Task Board.

## Advanced Launch

1. Open `Advanced Launch`.
2. Pick a Codex saved agent or Codex harness.
3. Set the launch command to `definitely-not-swarm-ui-command-xyz`.
4. Click launch.
5. Pass: launch blocks before a terminal opens and the error says the command was not found by the login shell.
6. Fail: a PTY opens first, the row silently fails, or the message only says generic spawn failure.

## Full-Access Posture

1. Set the Codex launch command to `flux9`.
2. Click launch.
3. Pass: the review includes `Preflight`, `Trust posture: full access`, and full-access warning copy.
4. Pass: cancelling returns to the launcher without spawning a PTY.
5. Fail: `flux9` looks like an ordinary command with no posture warning.

## Task Board Rows

1. Paste three simple task rows into the Project Task Board.
2. Assign the rows to `Codex / implementer`.
3. Click `Launch 3`.
4. Pass: rows briefly show `preflighting`, then `preflight ok` or `preflight full access` before normal launch state.
5. Pass: no happy-path modal appears for the Task Board launch.
6. Fail: the Task Board asks for an extra modal on every normal launch.

## Bad Row Command

1. Temporarily set the Codex harness alias or saved command to `definitely-not-swarm-ui-command-xyz`.
2. Launch one selected Task Board row.
3. Pass: the row shows `launch failed` with a command-preflight blocker and no new PTY appears for that row.
4. Fail: the row opens a terminal before reporting the missing command.

## Team Launch

1. Create or select a team with one Codex profile and one Claude profile.
2. Set one member command to `flux9` or `flux`.
3. Launch the team.
4. Pass: the team review includes full-access warning copy for the relevant member.
5. Fail: team launch hides the member's dangerous posture.
