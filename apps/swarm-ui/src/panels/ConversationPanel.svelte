<!--
  ConversationPanel.svelte — Cross-agent chat view + operator controls

  Purpose:
    A live, scope-wide transcript of every message flowing between agents, so
    the user can watch conversations unfold without clicking individual edges.
    Adds an operator message bar that broadcasts to every agent in scope, and
    a "Stop" button that fan-outs Ctrl-C to all bound PTYs.

  Wiring:
    - Subscribes to `$messages` (already scope-filtered in stores/swarm.ts).
    - `broadcastOperatorMessage(scope, text)` writes one row per recipient
      and emits `message.broadcast` so ConnectionEdge packet animations pulse.
    - `sendScopeSigint(scope)` walks the binder map and sends 0x03 to every
      PTY we still own. External adopters are skipped by necessity.

  This panel deliberately does not call any MCP tools — the UI has no MCP
  client. All writes go through Tauri commands that hit swarm.db directly,
  matching the `ui_clear_messages` pattern in ui_commands.rs.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { messages, instances, activeScope } from '../stores/swarm';
  import {
    broadcastOperatorMessage,
    sendScopeSigint,
  } from '../stores/pty';
  import { formatTimestamp } from '../lib/time';
  import { isSystemMessage } from '../lib/messages';
  import { personaForSender } from '../lib/persona';
  import type { Message, Instance } from '../lib/types';

  let draft = '';
  let sending = false;
  let stopping = false;
  let error: string | null = null;
  let hideSystemMessages = false;
  let feedEl: HTMLDivElement | null = null;
  let previousMessageCount = 0;

  // Stable lookup: instance id -> short display label so the transcript reads
  // as "planner-a → implementer-b" instead of two uuid fragments. Derived
  // from the `instances` store which is already scope-filtered.
  function labelFor(id: string, instMap: Map<string, Instance>): string {
    if (id.startsWith('operator:')) return 'You';
    if (id === 'system') return 'system';
    const inst = instMap.get(id);
    const name = inst?.label?.match(/name:([^\s,]+)/)?.[1];
    if (name) return name;
    const role = inst?.label?.match(/role:([^\s,]+)/)?.[1];
    if (role) return `${role}:${id.slice(0, 6)}`;
    return id.slice(0, 8);
  }

  // Store is newest-first; spread before reverse so the shared array isn't mutated.
  $: ascending = [...$messages].reverse();

  $: visibleMessages = hideSystemMessages
    ? ascending.filter((m) => !isSystemMessage(m))
    : ascending;

  // System messages are useful for debugging but clutter the live feel, so we
  // offer a toggle. Counting always runs against the full list.
  $: systemMessageCount = ascending.filter(isSystemMessage).length;

  $: canSend = Boolean($activeScope) && draft.trim().length > 0 && !sending;
  $: canStop = Boolean($activeScope) && !stopping;

  // Auto-scroll to the bottom whenever the message list grows. Only scrolls
  // when new messages land — user-initiated scrolling up to review history
  // isn't fought by every incoming packet.
  $: if (visibleMessages.length !== previousMessageCount) {
    previousMessageCount = visibleMessages.length;
    scrollToBottom();
  }

  async function scrollToBottom() {
    await tick();
    if (!feedEl) return;
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  async function handleSend() {
    const scope = $activeScope;
    const text = draft.trim();
    if (!scope || !text || sending) return;
    sending = true;
    error = null;
    try {
      const recipients = await broadcastOperatorMessage(scope, text);
      if (recipients === 0) {
        error = 'No agents in this scope to broadcast to.';
      } else {
        draft = '';
      }
    } catch (err) {
      console.error('[ConversationPanel] broadcast failed:', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sending = false;
    }
  }

  async function handleStop() {
    const scope = $activeScope;
    if (!scope || stopping) return;
    stopping = true;
    error = null;
    try {
      const count = await sendScopeSigint(scope);
      if (count === 0) {
        error =
          'No PTYs bound in this UI session. External agents must be stopped in their own terminal.';
      }
    } catch (err) {
      console.error('[ConversationPanel] stop failed:', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      stopping = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    // Cmd/Ctrl+Enter sends, plain Enter inserts a newline. Matches the rest
    // of the app's input conventions (Inspector notes, etc.).
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleSend();
    }
  }

  onMount(() => {
    previousMessageCount = visibleMessages.length;
    void scrollToBottom();
  });
</script>

<div class="conversation-panel">
  <header class="conv-header">
    <div class="conv-title">
      <span class="conv-label">Conversation</span>
      <span class="conv-scope">{$activeScope ?? 'no scope'}</span>
    </div>
    <div class="conv-header-actions">
      {#if systemMessageCount > 0}
        <button
          type="button"
          class="filter-btn"
          class:active={hideSystemMessages}
          on:click={() => (hideSystemMessages = !hideSystemMessages)}
          title={hideSystemMessages ? 'Show system messages' : 'Hide system messages'}
        >
          {hideSystemMessages ? `+${systemMessageCount} system` : 'Hide system'}
        </button>
      {/if}
      <button
        type="button"
        class="stop-btn"
        disabled={!canStop}
        on:click={handleStop}
        title="Send Ctrl-C to every agent in this scope"
      >
        {stopping ? 'Stopping…' : 'Stop all'}
      </button>
    </div>
  </header>

  <div class="feed" bind:this={feedEl} role="log" aria-live="polite">
    {#if visibleMessages.length === 0}
      <div class="empty">
        {#if !$activeScope}
          Pick a scope to see messages.
        {:else}
          No messages yet in <code>{$activeScope}</code>. Type below to broadcast.
        {/if}
      </div>
    {:else}
      {#each visibleMessages as msg (msg.id)}
        {@const isOperator = msg.sender.startsWith('operator:')}
        {@const isSystem = isSystemMessage(msg)}
        {@const senderEmoji = personaForSender(msg.sender, $instances)}
        <div class="msg" class:operator={isOperator} class:system={isSystem}>
          <span
            class="msg-avatar"
            title={labelFor(msg.sender, $instances)}
            aria-hidden="true"
          >
            {senderEmoji}
          </span>
          <div class="msg-body">
            <div class="msg-meta">
              <span class="msg-sender">{labelFor(msg.sender, $instances)}</span>
              <span class="msg-arrow">→</span>
              <span class="msg-recipient">
                {msg.recipient ? labelFor(msg.recipient, $instances) : 'all'}
              </span>
              <span class="msg-time">{formatTimestamp(msg.created_at)}</span>
            </div>
            <div class="msg-content">{msg.content}</div>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if error}
    <div class="error" role="alert">{error}</div>
  {/if}

  <div class="composer">
    <textarea
      bind:value={draft}
      on:keydown={handleKeydown}
      placeholder={$activeScope
        ? 'Broadcast to every agent in scope… (⌘↵ to send)'
        : 'No active scope'}
      disabled={!$activeScope || sending}
      rows="3"
    ></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ sends to all agents in {$activeScope ?? 'scope'}</span>
      <button
        type="button"
        class="send-btn"
        disabled={!canSend}
        on:click={handleSend}
      >
        {sending ? 'Sending…' : 'Broadcast'}
      </button>
    </div>
  </div>
</div>

<style>
  .conversation-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: transparent;
    overflow: hidden;
  }

  .conv-header,
  .feed,
  .error,
  .composer {
    position: relative;
    z-index: 1;
  }

  .conv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px 8px;
    border-bottom: 1px solid var(--node-border, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }

  .conv-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .conv-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-secondary, #a9b1d6);
  }

  .conv-scope {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--text-primary, #c0caf5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conv-header-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .filter-btn,
  .stop-btn,
  .send-btn {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--node-border, rgba(255, 255, 255, 0.12));
    background: transparent;
    color: var(--text-primary, #c0caf5);
    cursor: pointer;
    font-family: inherit;
    transition: background 120ms ease, border-color 120ms ease;
  }

  .filter-btn:hover,
  .stop-btn:hover:not(:disabled),
  .send-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.06);
  }

  .filter-btn.active {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.25);
  }

  .stop-btn {
    border-color: rgba(247, 118, 142, 0.35);
    color: #f7768e;
  }

  .stop-btn:hover:not(:disabled) {
    background: rgba(247, 118, 142, 0.12);
  }

  .stop-btn:disabled,
  .send-btn:disabled,
  .composer textarea:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    color: var(--text-secondary, #a9b1d6);
    font-size: 12px;
    text-align: center;
    padding: 32px 12px;
  }

  .empty code {
    background: rgba(255, 255, 255, 0.08);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 11px;
  }

  .msg {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.03);
    border-left: 2px solid rgba(122, 162, 247, 0.5);
    border-radius: 4px;
  }

  .msg-avatar {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    font-size: 14px;
    line-height: 1;
    border: 1px solid var(--node-border, rgba(255, 255, 255, 0.18));
    background: rgba(255, 255, 255, 0.04);
    border-radius: 4px;
    user-select: none;
  }

  .msg-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .msg.operator {
    border-left-color: #e0af68;
    background: rgba(224, 175, 104, 0.06);
  }

  .msg.system {
    border-left-color: rgba(255, 255, 255, 0.15);
    opacity: 0.72;
  }

  /* Encom: square avatar chip with white-LED hairline */
  :global([data-theme="tron-encom-os"]) .conversation-panel {
    --chat-accent: #ffe66d;
    --chat-amber: #ffb13b;
    --chat-danger: #ff5d73;
    --chat-muted: #9aa3af;
    background:
      radial-gradient(circle at 72% 14%, rgba(255, 217, 74, 0.08), transparent 34%),
      radial-gradient(circle at 18% 80%, rgba(255, 255, 255, 0.045), transparent 34%);
  }

  :global([data-theme="tron-encom-os"]) .conversation-panel::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.034) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.028) 1px, transparent 1px);
    background-size: 28px 28px;
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.55), transparent 72%);
  }

  :global([data-theme="tron-encom-os"]) .conv-header {
    padding: 12px 14px;
    border-bottom-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
    background:
      linear-gradient(90deg, rgba(255, 217, 74, 0.08), transparent 28%),
      rgba(255, 255, 255, 0.018);
  }

  :global([data-theme="tron-encom-os"]) .conv-label {
    color: var(--chat-accent);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-weight: 800;
    letter-spacing: 0.16em;
    text-shadow: 0 0 8px rgba(255, 217, 74, 0.28);
  }

  :global([data-theme="tron-encom-os"]) .conv-scope {
    color: var(--fg-primary, #eef3f7);
    text-shadow: 0 0 8px rgba(255, 255, 255, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .filter-btn,
  :global([data-theme="tron-encom-os"]) .stop-btn,
  :global([data-theme="tron-encom-os"]) .send-btn {
    border-radius: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  :global([data-theme="tron-encom-os"]) .filter-btn {
    border-color: rgba(255, 217, 74, 0.42);
    color: var(--chat-accent);
    background: rgba(255, 217, 74, 0.035);
  }

  :global([data-theme="tron-encom-os"]) .filter-btn:hover,
  :global([data-theme="tron-encom-os"]) .filter-btn.active {
    background: rgba(255, 217, 74, 0.1);
    box-shadow: 0 0 12px rgba(255, 217, 74, 0.16);
  }

  :global([data-theme="tron-encom-os"]) .stop-btn {
    border-color: rgba(255, 93, 115, 0.58);
    background: rgba(255, 93, 115, 0.035);
    color: var(--chat-danger);
    box-shadow: 0 0 10px rgba(255, 93, 115, 0.12);
  }

  :global([data-theme="tron-encom-os"]) .stop-btn:hover:not(:disabled) {
    background: rgba(255, 93, 115, 0.14);
    box-shadow: 0 0 16px rgba(255, 93, 115, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .feed {
    padding: 18px 18px;
    gap: 12px;
  }

  :global([data-theme="tron-encom-os"]) .empty {
    width: min(390px, 100%);
    margin: auto;
    padding: 22px 20px;
    border: 1px solid var(--led-line-s, rgba(255, 255, 255, 0.34));
    background:
      linear-gradient(135deg, rgba(255, 217, 74, 0.07), transparent 34%),
      rgba(255, 255, 255, 0.025);
    color: var(--fg-primary, #eef3f7);
    text-align: left;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.55;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.025),
      0 0 20px rgba(255, 255, 255, 0.08);
  }

  :global([data-theme="tron-encom-os"]) .empty::before {
    content: 'NO TRAFFIC';
    display: block;
    margin-bottom: 10px;
    color: var(--chat-accent);
    font-size: 11px;
    font-weight: 900;
    letter-spacing: 0.18em;
    text-shadow: 0 0 9px rgba(255, 217, 74, 0.3);
  }

  :global([data-theme="tron-encom-os"]) .empty code {
    border-radius: 0;
    background: rgba(255, 217, 74, 0.12);
    color: #fff8b4;
  }

  :global([data-theme="tron-encom-os"]) .msg {
    border: 1px solid var(--led-line-s, rgba(255, 255, 255, 0.3));
    border-left: 3px solid rgba(255, 217, 74, 0.62);
    border-radius: 0;
    background:
      linear-gradient(90deg, rgba(255, 217, 74, 0.055), transparent 34%),
      rgba(255, 255, 255, 0.025);
    box-shadow: 0 0 14px rgba(255, 255, 255, 0.06);
  }

  :global([data-theme="tron-encom-os"]) .msg.operator {
    border-left-color: var(--chat-amber);
    background:
      linear-gradient(90deg, rgba(255, 177, 59, 0.08), transparent 36%),
      rgba(255, 255, 255, 0.025);
  }

  :global([data-theme="tron-encom-os"]) .msg.system {
    border-left-color: rgba(154, 163, 175, 0.5);
    opacity: 0.82;
  }

  :global([data-theme="tron-encom-os"]) .msg-avatar {
    border: 1px solid var(--led-line, rgba(255, 255, 255, 0.55));
    background: var(--bg-base, #050505);
    border-radius: 0;
    box-shadow: 0 0 6px var(--glow, rgba(255, 255, 255, 0.18));
  }

  :global([data-theme="tron-encom-os"]) .msg-meta {
    color: var(--chat-muted);
  }

  :global([data-theme="tron-encom-os"]) .msg-sender,
  :global([data-theme="tron-encom-os"]) .msg-recipient,
  :global([data-theme="tron-encom-os"]) .msg-content {
    color: var(--fg-primary, #eef3f7);
  }

  :global([data-theme="tron-encom-os"]) .composer {
    padding: 13px 18px 15px;
    border-top-color: var(--led-line-s, rgba(255, 255, 255, 0.35));
    background:
      linear-gradient(0deg, rgba(255, 217, 74, 0.045), transparent 72%),
      rgba(0, 0, 0, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .composer textarea {
    min-height: 78px;
    border-radius: 0;
    border-color: var(--led-line-s, rgba(255, 255, 255, 0.36));
    background: rgba(0, 0, 0, 0.58);
    color: var(--fg-primary, #eef3f7);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.025),
      0 0 14px rgba(255, 255, 255, 0.055);
  }

  :global([data-theme="tron-encom-os"]) .composer textarea:focus {
    border-color: rgba(255, 217, 74, 0.62);
    box-shadow:
      inset 0 0 0 1px rgba(255, 217, 74, 0.06),
      0 0 16px rgba(255, 217, 74, 0.2);
  }

  :global([data-theme="tron-encom-os"]) .hint {
    color: var(--chat-muted);
  }

  :global([data-theme="tron-encom-os"]) .send-btn {
    border-color: rgba(255, 217, 74, 0.52);
    background: rgba(255, 217, 74, 0.08);
    color: var(--chat-accent);
  }

  :global([data-theme="tron-encom-os"]) .send-btn:hover:not(:disabled) {
    background: rgba(255, 217, 74, 0.16);
    box-shadow: 0 0 16px rgba(255, 217, 74, 0.22);
  }

  .msg-meta {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 10px;
    color: var(--text-secondary, #a9b1d6);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .msg-sender {
    color: var(--text-primary, #c0caf5);
    font-weight: 600;
  }

  .msg-arrow {
    opacity: 0.6;
  }

  .msg-recipient {
    color: var(--text-primary, #c0caf5);
  }

  .msg-time {
    margin-left: auto;
    opacity: 0.6;
  }

  .msg-content {
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-primary, #c0caf5);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error {
    margin: 0 14px 8px;
    padding: 6px 10px;
    border-radius: 4px;
    background: rgba(247, 118, 142, 0.12);
    border: 1px solid rgba(247, 118, 142, 0.3);
    color: #f7768e;
    font-size: 11px;
  }

  .composer {
    border-top: 1px solid var(--node-border, rgba(255, 255, 255, 0.08));
    padding: 10px 14px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }

  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 56px;
    padding: 8px 10px;
    border-radius: 4px;
    border: 1px solid var(--node-border, rgba(255, 255, 255, 0.12));
    background: rgba(0, 0, 0, 0.25);
    color: var(--text-primary, #c0caf5);
    font-family: inherit;
    font-size: 12px;
    line-height: 1.4;
  }

  .composer textarea:focus {
    outline: none;
    border-color: rgba(122, 162, 247, 0.55);
  }

  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .hint {
    font-size: 10px;
    color: var(--text-secondary, #a9b1d6);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
