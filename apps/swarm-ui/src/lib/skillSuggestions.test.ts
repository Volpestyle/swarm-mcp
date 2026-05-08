import { describe, expect, it } from 'bun:test';

import {
  appendSkillSuggestion,
  skillSuggestionsForHarness,
} from './skillSuggestions';

describe('skillSuggestions', () => {
  it('returns provider-specific suggestions', () => {
    expect(skillSuggestionsForHarness('codex').some((item) => item.value.includes('superpowers'))).toBe(true);
    expect(skillSuggestionsForHarness('claude').some((item) => item.value.includes('swarm register'))).toBe(true);
  });

  it('appends suggestions without duplicating existing lines', () => {
    const current = 'tauri\nplaywright';

    expect(appendSkillSuggestion(current, 'superpowers-systematic-debugging')).toBe(
      'tauri\nplaywright\nsuperpowers-systematic-debugging',
    );
    expect(appendSkillSuggestion(current, 'playwright')).toBe(current);
  });
});
