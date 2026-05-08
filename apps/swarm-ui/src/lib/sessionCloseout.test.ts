import { describe, expect, test } from 'bun:test';
import { browserPreviewIdentity } from './appIdentity';
import {
  buildSessionCloseoutMarkdown,
  buildSessionCloseoutPacket,
  fallbackCloseoutQuestions,
  followupsForAreaSentiment,
  initialSurveyStatus,
  shouldRunCloseout,
  timeoutSurveyStatus,
} from './sessionCloseout';

describe('session closeout', () => {
  test('runs for normal close triggers but not forced quit recovery', () => {
    expect(shouldRunCloseout('end-session')).toBe(true);
    expect(shouldRunCloseout('project-close')).toBe(true);
    expect(shouldRunCloseout('forced-quit-recovery')).toBe(false);
  });

  test('branches area followups by sentiment', () => {
    expect(followupsForAreaSentiment('good')).toEqual([]);
    expect(followupsForAreaSentiment('okay')).toHaveLength(1);
    expect(followupsForAreaSentiment('boring').join(' ')).toContain('hierarchy');
    expect(followupsForAreaSentiment('bad').join(' ')).toContain('proof');
  });

  test('shows fallback questions immediately while Majordomo can load', () => {
    expect(initialSurveyStatus(true)).toBe('majordomo-loading');
    expect(initialSurveyStatus(false)).toBe('fallback-visible');
    expect(timeoutSurveyStatus(12)).toBe('majordomo-timeout');
    expect(fallbackCloseoutQuestions(['capture-1.png'])[0]).toContain('captured area');
  });

  test('packet preserves app identity and captured images', () => {
    const packet = buildSessionCloseoutPacket({
      sessionId: 'session-1',
      endedAt: '2026-05-08T12:00:00.000Z',
      endKind: 'app-ui-quit',
      appIdentity: browserPreviewIdentity('0.1.0', '/Users/mathewfrazier/Desktop/swarm-mcp-lab'),
      projectRoot: '/tmp/project',
      scopeOrChannel: '/tmp/project#main',
      surfaceIds: ['majordomo', 'majordomo', 'canvas'],
      areaCaptures: ['area-captures/2026-05-08/session-1/001-button.png'],
      visualAtlasPath: 'output/visual-atlas/macro-phase-2',
      majordomoRuntime: {
        harness: 'hermes',
        model: null,
        provider: null,
        instanceId: 'agent-1',
        ptyId: 'pty-1',
        questionStatus: 'timeout',
        cleanupStatus: 'left-running-visible',
      },
    });

    expect(packet.appIdentity.appVariant).toBe('lab');
    expect(packet.surfaceIds).toEqual(['canvas', 'majordomo']);
    expect(packet.areaCaptures).toHaveLength(1);
    const markdown = buildSessionCloseoutMarkdown(packet, fallbackCloseoutQuestions(packet.areaCaptures));
    expect(markdown).toContain('swarm-ui lab v0.1.0');
    expect(markdown).toContain('left-running-visible');
  });
});
