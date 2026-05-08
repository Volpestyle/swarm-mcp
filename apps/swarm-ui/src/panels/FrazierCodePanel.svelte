<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  import frazierCodeTronUrl from '../assets/fraziercode-tron-2.jpg';

  export let open = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  type BranchDetail = {
    label: string;
    value: string;
    href?: string;
  };

  const branchDetails: BranchDetail[] = [
    { label: 'Edition', value: 'Experimental - FrazierCode' },
    { label: 'Commit version', value: 'Current working checkout' },
    { label: 'GitHub', value: 'github.com/Volpestyle/swarm-mcp', href: 'https://github.com/Volpestyle/swarm-mcp.git' },
    { label: 'Branch target', value: 'experimental-frazier' },
    { label: 'Branch README', value: 'Documents branch-specific navigation and upload hygiene' },
  ];

  const originCredits = [
    'VolpeStyle created swarm-mcp: the shared SQLite coordination layer, MCP tool surface, and clean minimal foundation for local multi-agent collaboration.',
    'The lineage stays visible here: vuhlpcode to swarm to a stylish agentic hub that keeps coordination practical instead of ornamental.',
    'This branch is intended as a respectful experimental UI lane that sweetens the existing core rather than replacing or competing with it.',
  ];

  const branchExtensions = [
    'Added the Tron Encom OS presentation layer, default theme direction, right-rail menu surfaces, and the FrazierCode [Agentic] archive page.',
    'Polished graph overlay layout, folder chrome, agent placards, role badges, provider logos, chat styling, inspect surfaces, and connection handles.',
    'Investigated PTY/TTY lifecycle confusion where terminated daemon or terminal sessions could still leave active-looking cards, then tightened recovery and reduced log noise.',
    'Kept the working graph first: visual upgrades stay attached to real launch, inspect, chat, analyze, and kill-path behavior.',
  ];

  const roadmapItems = [
    'Productized app launch with a real icon, bundled desktop path, reusable launch profiles, and explicit trust postures.',
    'Acceleration tooling: internal screenshots, UI export/import, CLI control, and visual-regression support.',
    'Agent identity overhaul: overview-first agent cards, terminal as a mode, editable identity, skills, mission, and runtime posture.',
    'Project spaces with real project pages, boundaries, memberships, assets, notes, and agent attachments.',
    'Assets and multimodal context: screenshots, images, protocols, references, and moodboards as first-class objects.',
    'Startup branding and credits that stay tasteful and keep artwork out of the live working canvas.',
    'Secondary theme split for Encom Glass Deck and DarkFolder Silhouette, plus protocol/workflow views.',
    'Analyze v2: cross-platform process inspection and kill routing without weakening exact-vs-estimated attribution rules.',
  ];

  function closeOverlay(): void {
    dispatch('close');
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!open || event.defaultPrevented) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeOverlay();
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

{#if open}
  <div class="frazier-overlay">
    <button
      type="button"
      class="frazier-backdrop"
      aria-label="Close FrazierCode panel"
      on:click={closeOverlay}
    ></button>

    <dialog open class="frazier-modal" aria-labelledby="frazier-title">
      <header class="frazier-header">
        <div class="frazier-title-block">
          <span class="frazier-kicker">Main menu archive</span>
          <h2 id="frazier-title">FrazierCode <span>[Agentic]</span></h2>
          <p>
            Experimental branch notes for a visual/operator layer on top of the
            original swarm-mcp foundation. Original project credit comes first.
          </p>
        </div>

        <button
          type="button"
          class="frazier-close"
          on:click={closeOverlay}
          aria-label="Close FrazierCode panel"
          title="Close FrazierCode panel"
        >
          ×
        </button>
      </header>

      <div class="frazier-scroll">
        <section class="version-strip" aria-label="Branch version details">
          {#each branchDetails as detail}
            <div>
              <span>{detail.label}</span>
              {#if detail.href}
                <a href={detail.href} target="_blank" rel="noreferrer">{detail.value}</a>
              {:else}
                <strong>{detail.value}</strong>
              {/if}
            </div>
          {/each}
        </section>

        <section class="frazier-copy-grid">
          <article class="frazier-card frazier-card--lead">
            <span class="card-kicker">Origin credit</span>
            <p>
              swarm-mcp starts with VolpeStyle's core work: a minimal, useful way
              for local coding agents to discover each other, coordinate through
              SQLite, and become visible as a working agentic hub.
            </p>
            <ul>
              {#each originCredits as item}
                <li>{item}</li>
              {/each}
            </ul>
          </article>

          <article class="frazier-card">
            <span class="card-kicker">FrazierCode branch additions</span>
            <ul>
              {#each branchExtensions as item}
                <li>{item}</li>
              {/each}
            </ul>
          </article>
        </section>

        <section class="roadmap-panel">
          <div class="roadmap-copy">
            <span class="card-kicker">Future overhaul direction</span>
            <p>
              The next plans move the app toward an agent-first orchestration OS:
              launch profiles, better capture tooling, project spaces, real asset
              context, protocol views, and cross-platform analysis.
            </p>
          </div>
          <ol>
            {#each roadmapItems as item}
              <li>{item}</li>
            {/each}
          </ol>
        </section>

        <figure class="frazier-art">
          <img src={frazierCodeTronUrl} alt="FrazierCode Agentic Tron concept art" />
        </figure>
      </div>
    </dialog>
  </div>
{/if}

<style>
  .frazier-overlay {
    position: fixed;
    inset: 0;
    z-index: 58;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 112px 48px 44px;
    pointer-events: none;
  }

  .frazier-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background:
      radial-gradient(circle at 70% 16%, rgba(255, 217, 74, 0.1), transparent 32%),
      radial-gradient(circle at 24% 74%, rgba(111, 224, 255, 0.1), transparent 36%),
      rgba(0, 0, 0, 0.62);
    cursor: pointer;
    pointer-events: auto;
  }

  .frazier-modal {
    position: relative;
    width: min(1180px, calc(100vw - 180px));
    max-height: min(900px, calc(100vh - 96px));
    margin: 0;
    padding: 0;
    border: 2px solid var(--led-line-s, rgba(255, 255, 255, 0.42));
    border-radius: 0;
    background:
      linear-gradient(135deg, rgba(255, 217, 74, 0.08), transparent 24%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.06), transparent 22%),
      rgba(0, 0, 0, 0.94);
    color: var(--fg-primary, #eef3f7);
    box-shadow:
      0 0 28px rgba(255, 255, 255, 0.2),
      0 0 42px rgba(255, 166, 0, 0.16),
      0 30px 120px rgba(0, 0, 0, 0.76);
    overflow: hidden;
    pointer-events: auto;
  }

  .frazier-modal::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
    background-size: 36px 36px;
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.7), transparent 68%);
  }

  .frazier-header {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    gap: 18px;
    padding: 22px 24px 18px;
    border-bottom: 1px solid var(--led-line-s, rgba(255, 255, 255, 0.35));
  }

  .frazier-title-block {
    min-width: 0;
  }

  .frazier-kicker,
  .card-kicker {
    display: block;
    color: #ffe66d;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.18em;
    line-height: 1;
    text-transform: uppercase;
    text-shadow: 0 0 9px rgba(255, 217, 74, 0.38);
  }

  .frazier-title-block h2 {
    margin: 10px 0 6px;
    color: #fff8b4;
    font-size: clamp(30px, 5vw, 62px);
    line-height: 0.92;
    letter-spacing: -0.04em;
    text-shadow:
      0 0 14px rgba(255, 217, 74, 0.44),
      0 0 28px rgba(255, 255, 255, 0.18);
  }

  .frazier-title-block h2 span {
    color: #eef3f7;
    letter-spacing: -0.02em;
  }

  .frazier-title-block p {
    max-width: 760px;
    margin: 0;
    color: var(--fg-muted, #9ba4b1);
    font-size: 14px;
    line-height: 1.5;
  }

  .frazier-close {
    width: 42px;
    height: 42px;
    border: 1px solid var(--led-line-s, rgba(255, 255, 255, 0.42));
    border-radius: 0;
    background: rgba(255, 255, 255, 0.025);
    color: var(--fg-primary, #eef3f7);
    font-size: 30px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.12);
  }

  .frazier-close:hover {
    border-color: rgba(255, 217, 74, 0.68);
    color: #ffe66d;
    box-shadow: 0 0 18px rgba(255, 217, 74, 0.22);
  }

  .frazier-scroll {
    position: relative;
    z-index: 1;
    max-height: calc(min(900px, 100vh - 96px) - 150px);
    overflow: auto;
    padding: 20px 24px 26px;
  }

  .version-strip {
    display: grid;
    grid-template-columns: 1.1fr 1fr 1.4fr 1fr 1.7fr;
    gap: 1px;
    margin-bottom: 16px;
    border: 1px solid rgba(255, 217, 74, 0.3);
    background: rgba(255, 217, 74, 0.14);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.025),
      0 0 14px rgba(255, 217, 74, 0.08);
  }

  .version-strip > div {
    min-width: 0;
    padding: 10px 11px;
    background: rgba(0, 0, 0, 0.72);
  }

  .version-strip span {
    display: block;
    margin-bottom: 5px;
    color: var(--fg-muted, #9ba4b1);
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.13em;
    line-height: 1;
    text-transform: uppercase;
  }

  .version-strip strong,
  .version-strip a {
    display: block;
    overflow: hidden;
    color: var(--fg-primary, #eef3f7);
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .version-strip a {
    color: #fff2a3;
    text-decoration: none;
  }

  .version-strip a:hover {
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  .frazier-copy-grid {
    display: grid;
    grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
    gap: 14px;
    margin-bottom: 18px;
  }

  .frazier-card {
    border: 1px solid var(--led-line-s, rgba(255, 255, 255, 0.32));
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.06), transparent 36%),
      rgba(255, 255, 255, 0.025);
    padding: 15px 16px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  }

  .frazier-card--lead {
    border-color: rgba(255, 217, 74, 0.48);
    box-shadow:
      inset 0 0 0 1px rgba(255, 217, 74, 0.05),
      0 0 18px rgba(255, 217, 74, 0.1);
  }

  .frazier-card p {
    margin: 10px 0 0;
    color: var(--fg-primary, #eef3f7);
    font-size: 14px;
    line-height: 1.55;
  }

  .frazier-card ul {
    margin: 10px 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 8px;
  }

  .frazier-card li {
    position: relative;
    padding-left: 16px;
    color: var(--fg-muted, #a4adbb);
    font-size: 12.5px;
    line-height: 1.42;
  }

  .frazier-card li::before {
    content: '';
    position: absolute;
    top: 0.68em;
    left: 0;
    width: 7px;
    height: 2px;
    background: #ffe66d;
    box-shadow: 0 0 8px rgba(255, 217, 74, 0.45);
  }

  .roadmap-panel {
    display: grid;
    grid-template-columns: minmax(220px, 0.7fr) minmax(0, 1.3fr);
    gap: 16px;
    margin-bottom: 18px;
    padding: 16px;
    border: 1px solid var(--led-line-s, rgba(255, 255, 255, 0.32));
    background:
      linear-gradient(135deg, rgba(111, 224, 255, 0.055), transparent 34%),
      rgba(255, 255, 255, 0.018);
  }

  .roadmap-copy p {
    margin: 10px 0 0;
    color: var(--fg-muted, #a4adbb);
    font-size: 13px;
    line-height: 1.5;
  }

  .roadmap-panel ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    counter-reset: roadmap;
  }

  .roadmap-panel li {
    position: relative;
    min-height: 58px;
    padding: 10px 10px 10px 36px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(0, 0, 0, 0.42);
    color: var(--fg-muted, #a4adbb);
    font-size: 11.5px;
    line-height: 1.38;
    counter-increment: roadmap;
  }

  .roadmap-panel li::before {
    content: counter(roadmap, decimal-leading-zero);
    position: absolute;
    left: 10px;
    top: 10px;
    color: #ffe66d;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 10px;
    font-weight: 900;
    text-shadow: 0 0 8px rgba(255, 217, 74, 0.3);
  }

  .frazier-art {
    margin: 0;
    overflow: auto;
    border: 2px solid rgba(255, 217, 74, 0.44);
    background: #000;
    box-shadow:
      0 0 18px rgba(255, 217, 74, 0.14),
      0 0 32px rgba(111, 224, 255, 0.1);
  }

  .frazier-art img {
    display: block;
    width: 1072px;
    max-width: none;
    height: auto;
  }

  @media (max-width: 920px) {
    .frazier-overlay {
      padding: 32px 16px 96px;
    }

    .frazier-modal {
      width: calc(100vw - 32px);
      max-height: calc(100vh - 128px);
    }

    .frazier-copy-grid {
      grid-template-columns: 1fr;
    }

    .version-strip,
    .roadmap-panel,
    .roadmap-panel ol {
      grid-template-columns: 1fr;
    }
  }
</style>
