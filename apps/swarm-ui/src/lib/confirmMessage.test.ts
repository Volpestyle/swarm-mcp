import { describe, expect, it } from 'bun:test';

import { parseConfirmMessage } from './confirmMessage';

describe('parseConfirmMessage', () => {
  it('turns launch review copy into readable sections', () => {
    const parsed = parseConfirmMessage([
      'Review this launch before spawning the agent.',
      '',
      '- Working dir: /Users/mathewfrazier/Desktop',
      '- Command: flux9',
      '- Scope: /Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul',
      '',
      'Incongruencies found:',
      '- Full-access command posture: flux9 can bypass normal permission or sandbox checks.',
    ].join('\n'));

    expect(parsed.intro).toEqual(['Review this launch before spawning the agent.']);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].heading).toBe('Launch details');
    expect(parsed.sections[0].items[0]).toEqual({
      label: 'Working dir',
      value: '/Users/mathewfrazier/Desktop',
    });
    expect(parsed.sections[1].heading).toBe('Incongruencies found');
    expect(parsed.sections[1].tone).toBe('warning');
  });
});
