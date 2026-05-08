import { describe, expect, it } from 'bun:test';

import {
  commandProviderWarning,
  extractLaunchExecutable,
  fallbackLaunchCommandPreflight,
  inferCommandTrustPosture,
  shellWords,
  summarizeLaunchCommandPreflight,
} from './launchPreflight';

describe('launchPreflight', () => {
  it('extracts the executable through env and exec prefixes', () => {
    expect(extractLaunchExecutable('SWARM=1 exec flux9 --fast').executable).toBe('flux9');
    expect(extractLaunchExecutable('env CODEX_HOME=/tmp codex --model gpt-5').executable).toBe('codex');
  });

  it('keeps quoted executable tokens together and reports quote errors', () => {
    expect(shellWords('"custom command" --flag').words[0]).toBe('custom command');
    expect(extractLaunchExecutable('"unterminated').error).toContain('unterminated');
  });

  it('classifies full-access commands', () => {
    expect(inferCommandTrustPosture('flux9')).toBe('full-access');
    expect(inferCommandTrustPosture('codex --dangerously-bypass-approvals-and-sandbox')).toBe('full-access');
    expect(inferCommandTrustPosture('codex')).toBe('standard');
  });

  it('warns when a saved command looks mismatched with the harness', () => {
    expect(commandProviderWarning('flux', 'codex')).toContain('looks like claude');
    expect(commandProviderWarning('flux9', 'codex')).toBe('');
    expect(commandProviderWarning('openclaw chat', 'openclaw')).toBe('');
    expect(commandProviderWarning('hermes', 'hermes')).toBe('');
  });

  it('fallback blocks malformed commands but keeps browser checks nonblocking', () => {
    const malformed = fallbackLaunchCommandPreflight({ command: '"bad', harness: 'codex' });
    expect(malformed.ok).toBe(false);
    expect(malformed.blocker).toContain('unterminated');

    const browserOnly = fallbackLaunchCommandPreflight({ command: 'codex', harness: 'codex' });
    expect(browserOnly.ok).toBe(true);
    expect(summarizeLaunchCommandPreflight(browserOnly)).toContain('native PATH check');
  });
});
