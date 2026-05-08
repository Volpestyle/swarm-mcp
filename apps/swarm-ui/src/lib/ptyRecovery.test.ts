import { describe, expect, it } from 'bun:test';

import { harnessFromCommand } from './ptyRecovery';

describe('harnessFromCommand', () => {
  it('recognizes first-word harness commands with arguments', () => {
    expect(harnessFromCommand('openclaw chat')).toBe('openclaw');
    expect(harnessFromCommand('hermes --tui')).toBe('hermes');
  });
});
