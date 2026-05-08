import { describe, expect, test } from 'bun:test';
import {
  applyRuntimeTweakState,
  parseRuntimeTweakCommand,
  runtimeTweakCssVariables,
  type RuntimeTweakState,
} from './runtimeTweaks';

describe('runtime tweaks', () => {
  test('parses supported move and resize commands', () => {
    expect(parseRuntimeTweakCommand('/tweak move majordomo button right 12')).toEqual({
      kind: 'move',
      featureId: 'majordomo.ask-button',
      label: 'Majordomo button',
      axis: 'x',
      delta: 12,
    });
    expect(parseRuntimeTweakCommand('/tweak resize note surface wider 40')).toEqual({
      kind: 'resize',
      featureId: 'canvas.note-document-surface',
      label: 'Note surface',
      dimension: 'width',
      delta: 40,
    });
  });

  test('parses reset and accept commands', () => {
    expect(parseRuntimeTweakCommand('/tweak reset current')).toEqual({ kind: 'reset', target: 'current' });
    expect(parseRuntimeTweakCommand('/tweak accept current')).toEqual({ kind: 'accept', target: 'current' });
  });

  test('applies pending tweaks through css variables before acceptance', () => {
    let state: RuntimeTweakState = { pending: [], accepted: [] };
    state = applyRuntimeTweakState(state, parseRuntimeTweakCommand('/tweak move majordomo button right 12'));
    state = applyRuntimeTweakState(state, parseRuntimeTweakCommand('/tweak resize note surface wider 40'));

    expect(runtimeTweakCssVariables(state)['--tweak-majordomo-button-x']).toBe('12px');
    expect(runtimeTweakCssVariables(state)['--tweak-note-surface-width']).toBe('40px');

    state = applyRuntimeTweakState(state, parseRuntimeTweakCommand('/tweak accept current'));
    expect(state.pending).toEqual([]);
    expect(state.accepted).toHaveLength(2);
  });
});
