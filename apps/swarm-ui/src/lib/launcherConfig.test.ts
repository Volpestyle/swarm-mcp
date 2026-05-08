import { describe, expect, it } from 'bun:test';

import {
  buildLaunchPreflightReview,
  resolveEffectiveLaunchConfig,
  resolveLaunchScope,
} from './launcherConfig';
import type { LaunchProfile } from './types';

const trustedLocal: LaunchProfile = {
  id: 'trusted-local',
  name: 'Trusted Local',
  description: 'Codex default',
  harness: 'codex',
  command: 'codex',
  trustPosture: 'trusted-local',
  defaultRole: 'implementer',
  defaultScopeMode: 'follow-canvas',
};

const claudeFullAccess: LaunchProfile = {
  id: 'claude-full-access',
  name: 'Claude Full Access',
  description: 'Claude bypass posture',
  harness: 'claude',
  command: 'claude --dangerously-skip-permissions',
  trustPosture: 'trusted-local',
  defaultRole: 'planner',
  defaultScopeMode: 'follow-canvas',
};

describe('resolveEffectiveLaunchConfig', () => {
  it('lets a saved Claude agent profile command override a selected Codex launch profile', () => {
    const result = resolveEffectiveLaunchConfig({
      formHarness: 'claude',
      formRole: 'planner',
      profileCommand: 'claude --dangerously-skip-permissions',
      selectedLaunchProfile: trustedLocal,
      harnessAliases: {
        claude: '/Users/mathewfrazier/.local/bin/claude',
        codex: 'codex',
      },
      agentProfileActive: true,
    });

    expect(result.harness).toBe('claude');
    expect(result.role).toBe('planner');
    expect(result.command).toBe('claude --dangerously-skip-permissions');
    expect(result.profileOwnsLaunch).toBe(true);
    expect(result.commandSource).toBe('agent-profile-command');
  });

  it('uses the flux alias when a saved Claude profile stores it as the command override', () => {
    const result = resolveEffectiveLaunchConfig({
      formHarness: 'claude',
      formRole: 'planner',
      profileCommand: 'flux',
      selectedLaunchProfile: trustedLocal,
      harnessAliases: {
        claude: 'claude',
        codex: 'codex',
      },
      agentProfileActive: true,
    });

    expect(result.harness).toBe('claude');
    expect(result.command).toBe('flux');
    expect(result.commandSource).toBe('agent-profile-command');
  });

  it('keeps a saved Codex profile swarm-aware when flux9 is the command override', () => {
    const result = resolveEffectiveLaunchConfig({
      formHarness: 'codex',
      formRole: 'planner',
      profileCommand: 'flux9',
      selectedLaunchProfile: claudeFullAccess,
      harnessAliases: {
        claude: 'claude',
        codex: 'codex',
      },
      agentProfileActive: true,
    });

    expect(result.harness).toBe('codex');
    expect(result.command).toBe('flux9');
    expect(result.role).toBe('planner');
    expect(result.commandSource).toBe('agent-profile-command');
  });

  it('does not let a mismatched Codex launch profile command hijack a saved Claude profile', () => {
    const result = resolveEffectiveLaunchConfig({
      formHarness: 'claude',
      formRole: 'planner',
      profileCommand: '',
      selectedLaunchProfile: trustedLocal,
      harnessAliases: {
        claude: '/Users/mathewfrazier/.local/bin/claude',
        codex: 'codex',
      },
      agentProfileActive: true,
    });

    expect(result.harness).toBe('claude');
    expect(result.command).toBe('/Users/mathewfrazier/.local/bin/claude');
    expect(result.role).toBe('planner');
    expect(result.commandSource).toBe('harness-alias');
    expect(result.launchProfileCommandUsable).toBe(false);
  });

  it('ignores launch profile command presets when a saved agent profile is selected', () => {
    const result = resolveEffectiveLaunchConfig({
      formHarness: 'claude',
      formRole: 'planner',
      profileCommand: '',
      selectedLaunchProfile: claudeFullAccess,
      harnessAliases: {
        claude: '/Users/mathewfrazier/.local/bin/claude',
        codex: 'codex',
      },
      agentProfileActive: true,
    });

    expect(result.harness).toBe('claude');
    expect(result.command).toBe('/Users/mathewfrazier/.local/bin/claude');
    expect(result.role).toBe('planner');
    expect(result.commandSource).toBe('harness-alias');
    expect(result.launchProfileCommandUsable).toBe(false);
  });

  it('uses the selected launch profile only when no agent profile owns the launch', () => {
    const result = resolveEffectiveLaunchConfig({
      formHarness: 'claude',
      formRole: '',
      profileCommand: '',
      selectedLaunchProfile: trustedLocal,
      harnessAliases: {
        claude: '/Users/mathewfrazier/.local/bin/claude',
        codex: 'codex',
      },
      agentProfileActive: false,
    });

    expect(result.harness).toBe('codex');
    expect(result.command).toBe('codex');
    expect(result.role).toBe('implementer');
    expect(result.commandSource).toBe('launch-profile-command');
  });
});

describe('resolveLaunchScope', () => {
  it('uses the active canvas when the launch profile follows the canvas', () => {
    const result = resolveLaunchScope({
      explicitScopeOverride: '',
      activeCanvasScope: '/repo#overhaul',
      workingDirectory: '/repo',
      selectedLaunchProfile: trustedLocal,
      profileScope: '',
      now: new Date('2026-05-02T04:00:00.000Z'),
    });

    expect(result.scope).toBe('/repo#overhaul');
    expect(result.source).toBe('active-canvas');
    expect(result.matchesActiveFeed).toBe(true);
  });

  it('turns a fresh-project launch profile into an isolated project scope', () => {
    const result = resolveLaunchScope({
      explicitScopeOverride: '',
      activeCanvasScope: '/repo#overhaul',
      workingDirectory: '/repo',
      selectedLaunchProfile: {
        ...trustedLocal,
        defaultScopeMode: 'fresh-project',
      },
      profileScope: '',
      now: new Date('2026-05-02T04:00:00.000Z'),
    });

    expect(result.scope).toBe('/repo#fresh-20260502t040000z');
    expect(result.source).toBe('launch-profile-fresh');
    expect(result.matchesActiveFeed).toBe(false);
  });

  it('uses the active canvas before a saved agent profile scope', () => {
    const result = resolveLaunchScope({
      explicitScopeOverride: '',
      activeCanvasScope: '/repo#overhaul',
      workingDirectory: '/repo',
      selectedLaunchProfile: trustedLocal,
      profileScope: '/old-scope',
      now: new Date('2026-05-02T04:00:00.000Z'),
    });

    expect(result.scope).toBe('/repo#overhaul');
    expect(result.source).toBe('active-canvas');
    expect(result.matchesActiveFeed).toBe(true);
    expect(result.warning).toBe('');
  });

  it('lets an explicitly pinned launcher scope override the active feed', () => {
    const result = resolveLaunchScope({
      explicitScopeOverride: '/pinned-scope',
      activeCanvasScope: '/repo#overhaul',
      workingDirectory: '/repo',
      selectedLaunchProfile: trustedLocal,
      profileScope: '/old-scope',
      now: new Date('2026-05-02T04:00:00.000Z'),
    });

    expect(result.scope).toBe('/pinned-scope');
    expect(result.source).toBe('pinned-scope');
    expect(result.matchesActiveFeed).toBe(false);
    expect(result.warning).toContain('active feed');
  });

  it('falls back to a saved agent profile scope when no canvas channel is active', () => {
    const result = resolveLaunchScope({
      explicitScopeOverride: '',
      activeCanvasScope: null,
      workingDirectory: '/repo',
      selectedLaunchProfile: trustedLocal,
      profileScope: '/saved-profile-scope',
      now: new Date('2026-05-02T04:00:00.000Z'),
    });

    expect(result.scope).toBe('/saved-profile-scope');
    expect(result.source).toBe('agent-profile-scope');
    expect(result.matchesActiveFeed).toBe(false);
  });
});

describe('buildLaunchPreflightReview', () => {
  it('highlights scope and directory incongruencies before launch', () => {
    const review = buildLaunchPreflightReview({
      cwd: '/repo-b',
      harness: 'codex',
      command: 'codex',
      role: 'planner',
      scope: '/repo-a#overhaul',
      activeScope: '/repo-b#overhaul',
      scopeSource: 'Agent Profile scope override',
      commandSource: 'Harness alias from Settings',
      activeInstances: [
        {
          id: 'agent-1',
          scope: '/repo-b#overhaul',
          status: 'online',
          adopted: true,
        },
      ],
    });

    expect(review.hasIncongruencies).toBe(true);
    expect(review.title).toBe('Review launch incongruencies');
    expect(review.message).toContain('active feed is /repo-b#overhaul');
    expect(review.message).toContain('working dir is /repo-b');
    expect(review.message).toContain('No online agents are currently in /repo-a#overhaul');
  });

  it('confirms clean launches without warning copy', () => {
    const review = buildLaunchPreflightReview({
      cwd: '/repo',
      harness: 'claude',
      command: 'claude',
      role: 'implementer',
      scope: '/repo#overhaul',
      activeScope: '/repo#overhaul',
      scopeSource: 'Following active Conversation feed',
      commandSource: 'Raw harness name',
      activeInstances: [
        {
          id: 'agent-1',
          scope: '/repo#overhaul',
          status: 'online',
          adopted: true,
        },
      ],
    });

    expect(review.hasIncongruencies).toBe(false);
    expect(review.title).toBe('Confirm agent launch');
    expect(review.message).toContain('No scope, directory, or command incongruencies detected.');
  });

  it('does not flag empty fresh scopes as mismatched with existing agents', () => {
    const review = buildLaunchPreflightReview({
      cwd: '/repo',
      harness: 'codex',
      command: 'codex',
      role: 'planner',
      scope: '/repo#fresh-20260502t040000z',
      activeScope: '/repo#fresh-20260502t040000z',
      scopeSource: 'Fresh project scope from Launch Profile',
      commandSource: 'Raw harness name',
      activeInstances: [
        {
          id: 'agent-1',
          scope: '/repo#overhaul',
          status: 'online',
          adopted: true,
        },
      ],
    });

    expect(review.hasIncongruencies).toBe(false);
  });

  it('surfaces command preflight and full-access posture in the review', () => {
    const review = buildLaunchPreflightReview({
      cwd: '/repo',
      harness: 'codex',
      command: 'flux9',
      role: 'implementer',
      scope: '/repo#overhaul',
      activeScope: '/repo#overhaul',
      scopeSource: 'Following active Conversation feed',
      commandSource: 'Saved Agent Profile command',
      commandPreflight: {
        ok: true,
        command: 'flux9',
        executable: 'flux9',
        resolvedPath: 'flux9=codex --dangerously-bypass-approvals-and-sandbox',
        shell: '/bin/zsh',
        pathPreview: '/usr/local/bin:/opt/homebrew/bin',
        diagnostics: [],
        warnings: [],
        blocker: null,
        trustPosture: 'full-access',
        native: true,
      },
      activeInstances: [
        {
          id: 'agent-1',
          scope: '/repo#overhaul',
          status: 'online',
          adopted: true,
        },
      ],
    });

    expect(review.hasIncongruencies).toBe(true);
    expect(review.message).toContain('Preflight: /bin/zsh resolved flux9');
    expect(review.message).toContain('Trust posture: full access');
    expect(review.message).toContain('Full-access command posture');
  });
});
