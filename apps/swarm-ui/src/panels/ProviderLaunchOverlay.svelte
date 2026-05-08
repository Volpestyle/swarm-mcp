<script lang="ts">
  import {
    PRIMARY_AGENT_PROVIDER_CHOICES,
    type AgentProviderChoice,
  } from '../lib/agentProviders';
  import {
    STANDARD_AGENT_ROLE_PRESETS,
    type AgentRolePreset,
  } from '../lib/agentRolePresets';

  type ProviderSelectCallback = (choice: AgentProviderChoice) => void;
  type RoleSelectCallback = (
    role: string,
    choice: AgentProviderChoice,
  ) => void | Promise<void>;

  export let providers: AgentProviderChoice[] = PRIMARY_AGENT_PROVIDER_CHOICES;
  export let roleChoices: AgentRolePreset[] = STANDARD_AGENT_ROLE_PRESETS;
  export let selectedProvider: AgentProviderChoice | null = null;
  export let selectedProviderId: string | null = null;
  export let selectedHarness: string | null = null;
  export let title = 'Launch Agent';
  export let subtitle = 'Choose the company first, then give the new agent a role.';
  export let launching = false;
  export let error: string | null = null;
  export let floating = false;
  export let x: number | null = null;
  export let y: number | null = null;
  export let onProviderSelect: ProviderSelectCallback | null = null;
  export let onBack: (() => void) | null = null;
  export let onRoleSelect: RoleSelectCallback | null = null;
  export let onClose: (() => void) | null = null;

  let internalProvider: AgentProviderChoice | null = null;

  $: externalProvider = selectedProvider
    ?? providers.find((choice) => choice.id === selectedProviderId)
    ?? providers.find((choice) => choice.harness === selectedHarness)
    ?? null;
  $: activeProvider = externalProvider ?? internalProvider;
  $: overlayStyle = floating && x !== null && y !== null
    ? `left:${Math.round(x)}px; top:${Math.round(y)}px;`
    : '';
  $: activeProviderStyle = activeProvider ? providerStyle(activeProvider) : '';
  $: stepLabel = activeProvider ? 'Step 2 / 2' : 'Step 1 / 2';

  function providerStyle(choice: AgentProviderChoice): string {
    return [
      `--provider-accent:${choice.accent}`,
      `--provider-gradient:${choice.gradient}`,
      `--provider-aura:${choice.aura}`,
    ].join(';');
  }

  function selectProvider(event: MouseEvent | KeyboardEvent, choice: AgentProviderChoice): void {
    event.preventDefault();
    event.stopPropagation();
    internalProvider = choice;
    onProviderSelect?.(choice);
  }

  function goBack(): void {
    internalProvider = null;
    onBack?.();
  }

  function selectRole(event: MouseEvent | KeyboardEvent, role: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (!activeProvider || launching) return;
    void onRoleSelect?.(role, activeProvider);
  }

  function isKeyboardActivation(event: KeyboardEvent): boolean {
    return event.key === 'Enter' || event.key === ' ';
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose?.();
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div
  class:provider-launch-overlay--floating={floating}
  class="provider-launch-overlay"
  style={overlayStyle}
  role="dialog"
  tabindex="-1"
  aria-label={title}
  on:pointerdown|stopPropagation
  on:contextmenu|preventDefault
>
  <div class="provider-launch-stars" aria-hidden="true"></div>

  <header class="provider-launch-header">
    <div class="provider-launch-orbit" style={activeProviderStyle} aria-hidden="true">
      {#if activeProvider?.logoUrl}
        <img src={activeProvider.logoUrl} alt="" />
      {:else}
        <span>+</span>
      {/if}
    </div>
    <div class="provider-launch-heading">
      <span>{stepLabel}</span>
      <h2>{activeProvider ? `Choose ${activeProvider.label} role` : title}</h2>
      <p>{activeProvider ? activeProvider.brandLine : subtitle}</p>
    </div>
    {#if onClose}
      <button
        type="button"
        class="provider-launch-close"
        aria-label="Close provider picker"
        on:click={onClose}
      >
        ×
      </button>
    {/if}
  </header>

  {#if !activeProvider}
    <div class="provider-launch-grid" aria-label="Choose agent company">
      {#each providers as choice (choice.id)}
        <button
          type="button"
          class="provider-card"
          style={providerStyle(choice)}
          aria-label={`Choose ${choice.label}`}
          on:click={(event) => selectProvider(event, choice)}
          on:keydown={(event) => {
            if (isKeyboardActivation(event)) selectProvider(event, choice);
          }}
        >
          <span class="provider-card-glow" aria-hidden="true"></span>
          <span class="provider-logo-frame">
            {#if choice.logoUrl}
              <img src={choice.logoUrl} alt={choice.logoAlt} />
            {:else}
              <span>{choice.label.slice(0, 1)}</span>
            {/if}
          </span>
          <span class="provider-copy">
            <span>{choice.company}</span>
            <strong>{choice.label}</strong>
            <small>{choice.brandLine}</small>
          </span>
          <span class="provider-signal">
            <span>{choice.signal}</span>
            <i aria-hidden="true"></i>
          </span>
        </button>
      {/each}
    </div>
  {:else}
    <section class="provider-role-step" style={activeProviderStyle}>
      <div class="provider-selected-card">
        <span class="provider-selected-logo">
          {#if activeProvider.logoUrl}
            <img src={activeProvider.logoUrl} alt={activeProvider.logoAlt} />
          {:else}
            <span>{activeProvider.label.slice(0, 1)}</span>
          {/if}
        </span>
        <span class="provider-selected-copy">
          <span>{activeProvider.company}</span>
          <strong>{activeProvider.label}</strong>
          <small>{activeProvider.summary}</small>
        </span>
        <button type="button" on:click={goBack}>Back</button>
      </div>

      <div class="provider-role-grid" aria-label="Choose agent role">
        {#each roleChoices as role (role.id)}
          <button
            type="button"
            class="provider-role-card"
            disabled={launching}
            title={role.description}
            aria-label={`Launch ${activeProvider.label} as ${role.label}`}
            on:click={(event) => selectRole(event, role.role)}
            on:keydown={(event) => {
              if (isKeyboardActivation(event)) selectRole(event, role.role);
            }}
          >
            <span class="provider-role-emoji" aria-hidden="true">{role.emoji}</span>
            <span class="provider-role-copy">
              <strong>{role.label}</strong>
              <small>{role.description}</small>
            </span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if error}
    <p class="provider-launch-error">{error}</p>
  {/if}
</div>

<style>
  .provider-launch-overlay {
    position: relative;
    width: min(590px, calc(100vw - 28px));
    max-height: min(700px, calc(100vh - 28px));
    overflow: hidden auto;
    padding: 16px;
    border: 1px solid rgba(230, 207, 142, 0.28);
    border-radius: 8px;
    background:
      radial-gradient(circle at 10% 0%, rgba(0, 240, 96, 0.12), transparent 32%),
      radial-gradient(circle at 94% 10%, rgba(255, 107, 74, 0.16), transparent 34%),
      linear-gradient(180deg, rgba(230, 207, 142, 0.08), transparent 30%),
      rgba(2, 5, 9, 0.96);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08) inset,
      0 24px 76px rgba(0, 0, 0, 0.68),
      0 0 34px rgba(0, 240, 96, 0.1);
    color: rgba(245, 249, 255, 0.96);
    isolation: isolate;
    backdrop-filter: blur(26px) saturate(1.22);
    -webkit-backdrop-filter: blur(26px) saturate(1.22);
  }

  .provider-launch-overlay--floating {
    position: fixed;
    z-index: 92;
  }

  .provider-launch-stars {
    position: absolute;
    inset: 0;
    z-index: -1;
    background-image:
      radial-gradient(circle, rgba(230, 207, 142, 0.18) 0 1px, transparent 1.5px),
      linear-gradient(120deg, transparent 0 42%, rgba(0, 240, 96, 0.06) 48%, transparent 58%);
    background-position: 0 0, 0 0;
    background-size: 42px 42px, 100% 100%;
    opacity: 0.7;
    pointer-events: none;
  }

  .provider-launch-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    margin-bottom: 16px;
  }

  .provider-launch-orbit {
    display: grid;
    width: 56px;
    height: 56px;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--provider-accent, #e6cf8e) 55%, rgba(255, 255, 255, 0.2));
    border-radius: 8px;
    background:
      radial-gradient(circle at 50% 20%, var(--provider-aura, rgba(120, 210, 255, 0.3)), transparent 54%),
      rgba(255, 255, 255, 0.06);
    box-shadow: 0 0 30px color-mix(in srgb, var(--provider-accent, #e6cf8e) 24%, transparent);
  }

	  .provider-launch-orbit img,
	  .provider-logo-frame img,
	  .provider-selected-logo img {
	    display: block;
	    width: 100%;
	    height: 100%;
	    box-sizing: border-box;
	    padding: 8px;
	    object-fit: contain;
	  }

  .provider-launch-orbit span {
    color: rgba(255, 255, 255, 0.7);
    font-size: 22px;
    line-height: 1;
  }

  .provider-launch-heading {
    min-width: 0;
  }

  .provider-launch-heading span,
  .provider-copy > span,
  .provider-selected-copy > span,
  .provider-signal {
    display: block;
    color: rgba(230, 207, 142, 0.76);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .provider-launch-heading h2 {
    margin: 2px 0 4px;
    color: white;
    font-size: 22px;
    font-weight: 750;
    letter-spacing: 0;
    line-height: 1.05;
  }

  .provider-launch-heading p {
    margin: 0;
    color: rgba(223, 232, 255, 0.72);
    font-size: 13px;
    line-height: 1.4;
  }

  .provider-launch-close {
    display: grid;
    width: 34px;
    height: 34px;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 6px;
    background: rgba(230, 207, 142, 0.07);
    color: rgba(255, 255, 255, 0.82);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }

  .provider-launch-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .provider-card {
    position: relative;
    display: grid;
    grid-template-rows: auto minmax(72px, 1fr) auto;
    gap: 12px;
    min-height: 184px;
    overflow: hidden;
    padding: 13px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    background: var(--provider-gradient);
    color: inherit;
    text-align: left;
    cursor: pointer;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.09),
      0 16px 42px rgba(0, 0, 0, 0.28);
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease,
      transform 160ms ease;
  }

  .provider-card::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 42%);
    pointer-events: none;
  }

  .provider-card:hover,
  .provider-card:focus-visible {
    border-color: color-mix(in srgb, var(--provider-accent) 62%, white);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--provider-accent) 22%, transparent),
      0 22px 70px rgba(0, 0, 0, 0.42),
      0 0 42px color-mix(in srgb, var(--provider-accent) 24%, transparent);
    transform: translateY(-2px);
    outline: none;
  }

  .provider-card-glow {
    position: absolute;
    width: 108px;
    height: 108px;
    right: -36px;
    top: -38px;
    border-radius: 999px;
    background: var(--provider-aura);
    filter: blur(28px);
    opacity: 0.72;
    pointer-events: none;
  }

  .provider-logo-frame,
  .provider-selected-logo {
    display: grid;
    width: 70px;
    height: 70px;
    place-items: center;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 8px;
    background:
      radial-gradient(circle at 45% 18%, rgba(255, 255, 255, 0.16), transparent 54%),
      rgba(255, 255, 255, 0.08);
  }

  .provider-logo-frame {
    z-index: 1;
  }

  .provider-logo-frame > span,
  .provider-selected-logo > span {
    color: white;
    font-size: 26px;
    font-weight: 800;
  }

  .provider-copy {
    z-index: 1;
    display: grid;
    gap: 4px;
    align-self: end;
  }

  .provider-copy strong,
  .provider-selected-copy strong {
    display: block;
    color: white;
    font-size: 18px;
    font-weight: 760;
    letter-spacing: 0;
    line-height: 1.08;
  }

  .provider-copy small,
  .provider-selected-copy small {
    display: block;
    color: rgba(234, 241, 255, 0.72);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.35;
  }

  .provider-signal {
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 2px;
  }

  .provider-signal i {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--provider-accent);
    box-shadow: 0 0 16px var(--provider-accent);
  }

  .provider-role-step {
    display: grid;
    gap: 12px;
  }

  .provider-selected-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 13px;
    align-items: center;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--provider-accent) 42%, rgba(255, 255, 255, 0.14));
    border-radius: 8px;
    background:
      radial-gradient(circle at 15% 0%, var(--provider-aura), transparent 34%),
      rgba(255, 255, 255, 0.055);
  }

  .provider-selected-logo {
    width: 58px;
    height: 58px;
    border-radius: 8px;
  }

  .provider-selected-copy {
    min-width: 0;
  }

  .provider-selected-card button {
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.07);
    color: rgba(255, 255, 255, 0.84);
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .provider-role-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .provider-role-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 78px;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 8px;
    background:
      radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--provider-accent) 20%, transparent), transparent 58%),
      rgba(255, 255, 255, 0.055);
    color: rgba(247, 250, 255, 0.96);
    cursor: pointer;
    transition:
      border-color 150ms ease,
      background 150ms ease,
      transform 150ms ease;
  }

  .provider-role-card:hover,
  .provider-role-card:focus-visible {
    border-color: color-mix(in srgb, var(--provider-accent) 54%, white);
    background:
      radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--provider-accent) 28%, transparent), transparent 62%),
      rgba(255, 255, 255, 0.09);
    outline: none;
    transform: translateY(-1px);
  }

  .provider-role-card:disabled {
    cursor: progress;
    opacity: 0.5;
    transform: none;
  }

  .provider-role-emoji {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.18);
    font-size: 20px;
    line-height: 1;
  }

  .provider-role-copy {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

	  .provider-role-card strong {
	    max-width: 100%;
	    overflow: hidden;
	    color: white;
	    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0;
    line-height: 1.1;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider-role-card small {
    display: -webkit-box;
    overflow: hidden;
    color: rgba(234, 241, 255, 0.62);
    font-size: 10.5px;
    line-height: 1.25;
    text-align: left;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .provider-launch-error {
    margin: 14px 0 0;
    padding: 10px 12px;
    border: 1px solid rgba(255, 90, 90, 0.28);
    border-radius: 8px;
    background: rgba(120, 20, 30, 0.32);
    color: rgba(255, 212, 212, 0.96);
    font-size: 12px;
    line-height: 1.35;
  }

  :global([data-theme="tron-encom-os"]) .provider-launch-overlay {
    border-color: rgba(255, 255, 255, 0.72);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 26%),
      rgba(0, 0, 0, 0.92);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.18) inset,
      0 24px 76px rgba(0, 0, 0, 0.72),
      0 0 42px rgba(255, 255, 255, 0.18);
  }

  :global([data-theme="tron-encom-os"]) .provider-launch-stars {
    background-image:
      radial-gradient(circle, rgba(255, 255, 255, 0.2) 0 1px, transparent 1.4px),
      linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.09), transparent);
  }

  :global([data-theme="tron-encom-os"]) .provider-card,
  :global([data-theme="tron-encom-os"]) .provider-role-card,
  :global([data-theme="tron-encom-os"]) .provider-selected-card {
    border-color: rgba(255, 255, 255, 0.36);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.09), transparent 42%),
      rgba(0, 0, 0, 0.72);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 0 22px rgba(255, 255, 255, 0.08);
  }

  :global([data-theme="tron-encom-os"]) .provider-card:hover,
  :global([data-theme="tron-encom-os"]) .provider-card:focus-visible,
  :global([data-theme="tron-encom-os"]) .provider-role-card:hover,
  :global([data-theme="tron-encom-os"]) .provider-role-card:focus-visible {
    border-color: #ffffff;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.96),
      0 0 22px rgba(255, 255, 255, 0.62),
      0 0 54px rgba(255, 255, 255, 0.22);
  }

  :global([data-theme="tron-encom-os"]) .provider-launch-heading span,
  :global([data-theme="tron-encom-os"]) .provider-copy > span,
  :global([data-theme="tron-encom-os"]) .provider-selected-copy > span,
  :global([data-theme="tron-encom-os"]) .provider-signal {
    color: rgba(255, 255, 255, 0.7);
  }

  @media (max-width: 620px) {
    .provider-launch-overlay {
      width: calc(100vw - 20px);
      padding: 14px;
      border-radius: 8px;
    }

    .provider-launch-grid {
      grid-template-columns: 1fr;
    }

    .provider-card {
      min-height: 176px;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-rows: auto auto;
      align-items: center;
    }

    .provider-logo-frame {
      width: 68px;
      height: 68px;
    }

    .provider-copy {
      align-self: center;
    }

    .provider-signal {
      grid-column: 1 / -1;
    }

    .provider-role-grid {
      grid-template-columns: 1fr;
    }

    .provider-selected-card {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .provider-selected-card button {
      grid-column: 1 / -1;
      width: 100%;
    }
  }
</style>
