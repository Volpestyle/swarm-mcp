# May 1st Slice 7D Manual QA

Scope: app-restart survivor and rescue loop.

## Goal

If `swarm-ui` is killed or crashes while a bounded agent is running, the agent should survive with an explicit owner, purpose, timeout/idle policy, project, channel/scope, cwd, and task/background label. When `swarm-ui` is relaunched, the app should surface that survivor in Resume Center / running agents so the user does not have to find it manually.

## Acceptance Path

1. Launch one bounded task or background-work agent from `swarm-ui`.
2. Confirm the agent adopts a swarm instance row and enters `wait_for_activity`.
3. Kill or quit `swarm-ui` only.
4. Verify the agent process and MCP pid still exist.
5. Verify the same instance id remains in `~/.swarm-mcp/swarm.db` with the same scope, cwd, label, pid, owner, purpose, timeout, and idle policy.
6. Relaunch `swarm-ui`.
7. Confirm the survivor appears in Resume Center / running agents without manual DB or process hunting.
8. Use the visible rescue path:
   - reconnect or attach if supported
   - open in Terminal
   - open in Ghostty
   - copy attach/resume command
   - suspend
   - kill
9. Kill the survivor through the app and confirm the process, PTY, row, and active counts reconcile.

## Pass

- Killing `swarm-ui` does not kill explicit bounded survivor agents.
- Relaunching `swarm-ui` shows the survivor with project, purpose, status, timeout/idle policy, and cleanup controls.
- Rescue actions are visible; unsupported attach paths say so directly and provide a safe fallback.
- Kill cleanup removes the survivor process and row without phantom active/stale counts.

## Native Proof - 2026-05-02

- Native debug app launched from `/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui`.
- Command `#28` spawned survivor instance `f912ba8f-53ee-4fd9-8dbc-743d8b2b1436` with PTY `84629a59-e47b-4cae-b5eb-12f73a0a1693`.
- Command `#29` launched the guarded Codex standby prompt; event `#966` adopted the row with MCP pid `7158`, and event `#967` shows `wait_for_activity`.
- After killing only `swarm-ui` pid `6685`, SQLite still contained the same instance row and `ps` still showed the Codex/MCP process tree.
- After relaunching `swarm-ui`, command `#31` addressed the survivor by instance id, closed PTY `84629a59-e47b-4cae-b5eb-12f73a0a1693`, deregistered instance `f912ba8f-53ee-4fd9-8dbc-743d8b2b1436`, and terminated pid `7158`.
- Cleanup proof: the instance row count returned `0` and process search found no `f912ba8f`, `bg-7d-survivor`, or `84629a59` survivor process.

Limitations:

- This proves the native restart/rebind/kill backbone through the app worker and daemon state, not a human-visible installed-app screenshot. The human-visible click/screenshot path remains tied to the Slice 5C Accessibility/TCC revisit.

## Fail

- The agent dies when only `swarm-ui` is killed.
- The agent survives but the relaunched app does not surface it.
- The app shows a survivor but cannot explain how to reconnect, suspend, or kill it.
- Cleanup removes only the row while the process keeps running.
- Workspace switching or stale cleanup hides or deletes a valid survivor.
