export function setup() {
  return `Register this agent session with the local swarm.

1. Call the swarm \`register\` tool with \`directory\` (cwd), an optional machine-readable \`label\` (e.g. \`provider:codex-cli role:implementer\`), and \`scope\` / \`file_root\` only when explicitly required.
2. Call \`bootstrap\` for the atomic \`{instance, peers, unread_messages, tasks}\` snapshot.
3. Load the \`swarm-mcp\` skill for the full coordination playbook (role-specific flows, lock-conflict handling, KV patterns). If your runtime cannot load skills, see the \`protocol\` prompt for an inline fallback.

After context compaction or a fresh window, repeat this flow — do not rely on remembered prompt text.`;
}

export function protocol() {
  return `Inline fallback for runtimes that cannot load the \`swarm-mcp\` skill. Plugin-equipped runtimes should load the skill instead.

Minimum to function:

- \`register\` first, then \`bootstrap\` for the \`{instance, peers, unread_messages, tasks}\` snapshot. Re-run on compaction.
- Solo scope (empty \`peers\`) → skip per-edit \`lock_file\`. Re-enable when \`instance_changes\` reports peers joining.
- When peers exist: use \`get_file_context\` for read-only inspection and \`lock_file\` while editing. \`lock_file\` also returns peer annotations on the file, so no separate pre-check is needed. Default semantics are re-entrant for your own instance; pass \`exclusive=true\` only for one-shot mutexes (spawn coordination, singleton jobs).
- Lock conflict → prefer to pivot (different file or task). Use \`wait_for_activity\` to block on \`context.lock_released\` only when no other productive work is available; never sleep-poll.
- \`claim_task\` already moves a task to \`in_progress\`. Call \`update_task\` once at the end with \`done\` / \`failed\` / \`cancelled\` and a structured JSON \`result\` (\`{files_changed, test_status, summary}\`). Normal edit locks release automatically; internal \`/__swarm/\` mutex locks are managed by their owning flow.
- \`request_task\` (or \`request_task_batch\` with \`$N\` deps) for delegation. Use explicit \`review\` tasks for code review handoff; reserve \`approval_required\` for true approval gates. Use \`priority\` to control execution order.
- \`annotate\` for file-specific findings, \`broadcast\` for short status updates, \`send_message\` for durable targeted notes, and \`prompt_peer\` when a specific peer should notice soon.
- \`wait_for_activity\` is an idle optimization, not a delivery guarantee. React to \`new_messages\`, \`task_updates\`, \`kv_updates\`, \`instance_changes\`; if a peer wake prompt arrives, call \`poll_messages\` or \`bootstrap\`. \`[auto]\`-prefixed messages are system notifications; \`[signal:complete]\` broadcasts mean wrap up and deregister.
- Long-running tasks: publish \`kv_set("progress/<your-instance-id>", ...)\` so peers can check without interrupting.
- Treat sessions without a \`role:\` label token as generalists. Match \`role:\` / \`team:\` tokens when picking collaborators.`;
}

const ROLE_BOOTSTRAPS: Record<string, string> = {
  planner: `You are a **planner** in this swarm.

Load \`references/planner.md\` from the \`swarm-mcp\` skill for the decompose / delegate / monitor / recover playbook.

Minimum: check \`kv_get("owner/planner")\` and \`kv_get("plan/latest")\` to see if you should resume; use \`request_task\` (or \`request_task_batch\`) for delegation; broadcast \`[signal:complete]\` when all work is done.`,

  implementer: `You are an **implementer** in this swarm.

Load \`references/implementer.md\` from the \`swarm-mcp\` skill for the claim / edit / handoff playbook.

Minimum: claim the highest-priority \`open\` task matching your role; use \`get_file_context\` for read-only inspection and \`lock_file\` while editing (skip if alone in scope); on completion call \`update_task\` once with \`done\` / \`failed\` / \`cancelled\` and a structured \`result\` JSON (\`{files_changed, test_status, summary}\`).`,

  reviewer: `You are a **reviewer** in this swarm.

Load \`references/reviewer.md\` from the \`swarm-mcp\` skill for the review playbook.

Minimum: claim \`review\`-type tasks; inspect the upstream task's \`result\` plus the actual changes; \`update_task done\` to approve, or fail and create a \`fix\` task to push back. Use \`annotate\` for file-specific findings.`,

  researcher: `You are a **researcher** in this swarm.

Load \`references/researcher.md\` from the \`swarm-mcp\` skill for the investigate / publish-findings playbook.

Minimum: claim \`research\`-type tasks; read-only investigation; publish findings via \`annotate\` (file-specific) and \`kv_set\` (structured); \`update_task done\` with a summary \`result\`.`,
};

export function roleBootstrap(role: string | null | undefined) {
  if (!role) return "";
  return ROLE_BOOTSTRAPS[role.trim().toLowerCase()] ?? "";
}
