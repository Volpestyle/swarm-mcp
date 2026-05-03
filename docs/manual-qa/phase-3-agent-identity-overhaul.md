# Phase 3 Agent Identity Manual QA

This pass is a regression-recovery check against `swarm-mcp-active` behavior. It intentionally validates the active-style terminal node first; the overview-card experiment should not block basic launch/manual QA.

Closeout: accepted by Mathew on 2026-04-25. Phase 3 is closed with the current active-style terminal baseline, Agent Deck v2, launch/profile ownership cleanup, saved-agent management popups, and role/emoji customization.

1. Open the lab `swarm-ui` build and enter the canvas.
Expected: the right rail looks like active: Launch, Chat, Inspect, Analyze, Mobile, Settings, FrazierCode [Agentic], Hide/Show. The dark folder art appears in the shell surface header only, not inside the rail buttons.

2. Open Home with the Tron Encom OS theme selected.
Expected: Home uses active's white-LED Encom chrome, the nav hover/active state is a white row glow, the Start action is the only amber action, and the FrazierCode art appears as a dedicated card in Start instead of inside the right rail buttons.

3. Load a saved profile such as `Codex Beast` or `Claude Beast`.
Expected: the Launch command preview shows that profile's custom command, including bypass flags. A selected launch profile must not override the saved agent profile command.

4. Regression check the Claude/Codex launch resolver.
Expected: after selecting any Codex-oriented Launch Profile, loading `Claude Beast`, `Claude`, or `Claude Planner` still launches Claude Code, not Codex. The saved agent profile owns the command, harness, role, and bypass posture until you explicitly clear or replace it.

5. Regression check matching Launch Profile command presets.
Expected: when a saved Claude Agent Profile has no profile-specific launch command, selecting a Claude Launch Profile whose command includes bypass/full-access flags causes the terminal to auto-type that bypass command. A mismatched Codex Launch Profile must show a warning and must not hijack the saved Claude profile.

6. Check the active-style shell chrome.
Expected: the graph overlay/header matches `swarm-mcp-active`: the dark folder is a large shell-surface object in the overlay header, not a tiny folder inside right-side buttons. The right rail remains an icon list, and Tron terminal nodes use bright white square connection ports, resize handles, border glow, and message-edge glow.

7. Check profile skill suggestions.
Expected: Launch profile `Skills` shows compact provider-aware suggestion chips. Clicking a chip appends guidance to the skills field without duplicating existing text and without typing into a live terminal.

8. In Launch, create or load a Team Loadout from saved profiles.
Expected: profiles can be checked into a saved team, the team can be saved/updated/deleted, and `Launch Team Fresh` creates a new `#team-...` scope with fresh PTYs rather than reviving old instance rows.

9. Launch that saved profile.
Expected: the terminal auto-types the custom command with bypass flags, then auto-types the swarm bootstrap prompt.

10. Read the bootstrap prompt in the terminal.
Expected: it includes `Use the swarm register tool with directory="..."`, includes `scope="..."` when a canvas scope is active, then asks for `whoami`, `list_instances`, `poll_messages`, and `list_tasks`. It also tells the agent to act on messages/tasks before summarizing and report progress through swarm messages/broadcasts.

11. Inspect the launched node.
Expected: the node body opens on the live `Term` tab, not a blocking overview card. The active-style identity plate appears above the node with provider/model/name/role.

12. Open the node's `Deck` tab.
Expected: Agent Card v2 appears as a minimalist command deck with persona/provider, name/role, runtime, listener, tasks, active work, locks, unread messages, skills, permissions, and scope. Tron Encom OS should render the deck with sharp white LED frames, not rounded generic cards.

13. Read the Agent Deck internals against the bright node frame.
Expected: the outer LED edge can stay intense, but the deck contents remain brighter than the background and readable. Runtime/task/lock/message panels use restrained tone channels instead of one flat monochrome stack.

14. Check the `Current Work` panel in the Agent Deck.
Expected: the dark folder art pulses at the left of the panel. The panel shows the active assigned task file first, then falls back to a lock file, instance directory, or PTY cwd when no task file exists. If a task title or description includes `Step N`, `Part N`, or `Phase N`, the step badge shows that number; otherwise it says `No formal step`.

15. Check the node header identity chip.
Expected: the top node header no longer looks like a generic flat title bar. It reads as an Encom control strip: toned vertical control bars on the left, a brighter clickable identity chip with role-derived emoji/name/provider/role, a shortened path rail, crisp status badges, and square inspect/focus controls. Clicking the identity chip collapses the node to a compact card; clicking again expands it.

16. Return to the node's `Term` tab.
Expected: the live terminal is still attached, readable, and focusable. The card tabs must not resize the node unpredictably or break terminal input.

17. Open Inspector for that node and edit Agent Identity.
Expected: the skills field has the same provider-aware suggestion chips as Launch. The chips are a safe shortcut for common guidance, not a live `/skills` catalog; the live Claude/Codex slash-skill list remains terminal-source-of-truth for now.

18. Open Chat and send a message to one specific online agent.
Expected: the recipient picker can target one agent; the message appears as a direct operator message and the node listener badge can show unread/needs-poll until the agent polls.

19. Use the red close control on a stale PTY-only node.
Expected: the label says `Clear stale node`, and the node disappears without pretending to kill a live process.

20. Open Settings and run stale/offline cleanup.
Expected: stale instance rows and orphan PTY rows are both cleared. The result message calls out rows and orphan PTYs separately.

21. Open Analyze.
Expected: the page opens, scans system/process data, and the Tron theme styling matches active: stronger white frame, danger buttons, readable ledger rows, and bright process gauges.

22. Open FrazierCode [Agentic].
Expected: the branch/archive panel opens with the Tron artwork and closes from its close button, backdrop, or Escape.

23. Launch the Dockable app bundle.
Expected: `/Users/mathewfrazier/Applications/Swarm UI Lab.app` opens from Finder or the Dock with the updated app icon.
