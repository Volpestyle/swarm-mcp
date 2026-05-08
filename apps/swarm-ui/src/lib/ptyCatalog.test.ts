import { describe, expect, it } from 'bun:test';

import { reconcilePtyCatalog } from './ptyCatalog';
import type { BindingState, PtySession } from './types';

function makePty(id: string): PtySession {
  return {
    id,
    command: 'claude',
    cwd: '/Users/mathewfrazier/Desktop',
    started_at: 1_776_888_000_000,
    exit_code: null,
    bound_instance_id: null,
    launch_token: null,
    cols: 120,
    rows: 40,
    lease: null,
  };
}

describe('reconcilePtyCatalog', () => {
  it('drops PTYs that disappeared from backend truth and prunes their bindings', () => {
    const currentSessions = new Map<string, PtySession>([
      ['pty-stale', makePty('pty-stale')],
      ['pty-live', makePty('pty-live')],
    ]);
    const nextBindings: BindingState = {
      pending: [['token-stale', 'pty-stale']],
      resolved: [['instance-live', 'pty-live'], ['instance-stale', 'pty-stale']],
    };

    const result = reconcilePtyCatalog(currentSessions, nextBindings, [makePty('pty-live')]);

    expect([...result.sessionMap.keys()]).toEqual(['pty-live']);
    expect(result.removedPtyIds).toEqual(['pty-stale']);
    expect(result.bindings.pending).toEqual([]);
    expect(result.bindings.resolved).toEqual([['instance-live', 'pty-live']]);
  });

  it('keeps bindings intact when backend truth still contains the PTY', () => {
    const currentSessions = new Map<string, PtySession>([['pty-live', makePty('pty-live')]]);
    const nextBindings: BindingState = {
      pending: [['token-live', 'pty-live']],
      resolved: [['instance-live', 'pty-live']],
    };

    const result = reconcilePtyCatalog(currentSessions, nextBindings, [makePty('pty-live')]);

    expect(result.removedPtyIds).toEqual([]);
    expect(result.bindings).toEqual(nextBindings);
  });
});
