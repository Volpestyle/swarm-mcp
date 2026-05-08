# Listener Health Reliability Sync Manual QA

Date added: 2026-04-25

Purpose: verify that swarm-ui can distinguish an agent that is truly listening from one that only has a live heartbeat.

## Checklist

1. Start the lab UI.

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui
bunx tauri dev
```

Expected: swarm-ui launches from the lab checkout.

2. Launch one agent into `/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul`.

Expected: the node initially shows `Register needed`, `Adopting`, or `Unverified` until the child registers and calls swarm tools.

3. In the agent terminal, register and rehydrate.

Expected commands:

- `register`
- `whoami`
- `list_instances`
- `poll_messages`
- `list_tasks`

Expected UI: after `poll_messages`, the node shows `Polled` unless it has active work.

4. Put the agent into its idle loop with `wait_for_activity`.

Expected UI: the node shows `Listening`, and Inspector Listener Health shows a wait-loop timestamp.

5. Send a direct message to that agent from the Conversation panel or another swarm agent.

Expected UI: before the agent consumes the message, the node shows `Needs poll` and an unread badge.

6. Let the agent consume the message through `poll_messages` or `wait_for_activity`.

Expected UI: unread badge clears. Listener Health returns to `Polled`, `Listening`, or `Working`.

7. Inspect the node.

Expected: Inspector has a Listener Health section with State, Detail, Unread, Active Tasks, Last Poll, and Wait Loop.

## Automated Verification

Run:

```bash
cd /Users/mathewfrazier/Desktop/swarm-mcp-lab
bun test test/events.test.ts
cd apps/swarm-ui
bun test src/lib/agentListenerHealth.test.ts src/lib/graph.test.ts
```

Expected: all tests pass.
