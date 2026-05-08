import type { AppIdentity } from './appIdentity';

export type CloseoutTrigger =
  | 'end-session'
  | 'project-close'
  | 'app-ui-quit'
  | 'stop-all-agents'
  | 'leave-running-agent'
  | 'last-project-window-closed'
  | 'idle-end-confirmed'
  | 'forced-quit-recovery';

export type SurveyQuestionStatus =
  | 'fallback-visible'
  | 'majordomo-loading'
  | 'majordomo-ready'
  | 'majordomo-timeout'
  | 'majordomo-failed';

export type AreaSentiment = 'good' | 'okay' | 'boring' | 'bad';

export type SessionCloseoutPacket = {
  sessionId: string;
  endedAt: string;
  endKind: CloseoutTrigger;
  appIdentity: AppIdentity;
  projectRoot: string;
  scopeOrChannel: string;
  surfaceIds: string[];
  areaCaptures: string[];
  visualAtlasPath: string | null;
  majordomoRuntime: {
    harness: 'hermes' | 'fallback';
    model: string | null;
    provider: string | null;
    instanceId: string | null;
    ptyId: string | null;
    questionStatus: 'not-started' | 'loading' | 'ready' | 'timeout' | 'failed' | 'fallback-only';
    cleanupStatus: 'not-needed' | 'stopped' | 'left-running-visible' | 'failed';
  };
};

export function shouldRunCloseout(trigger: CloseoutTrigger): boolean {
  return trigger !== 'forced-quit-recovery';
}

export function followupsForAreaSentiment(sentiment: AreaSentiment): string[] {
  if (sentiment === 'good') return [];
  if (sentiment === 'okay') return ['What one small change would make this feel easier next time?'];
  if (sentiment === 'boring') {
    return [
      'Should this area feel calmer, sharper, or more energetic?',
      'Is the hierarchy clear enough to scan without effort?',
    ];
  }
  return [
    'Was this a visual, interaction, wording, or proof problem?',
    'What did you expect to happen instead?',
    'Should Majordomo create an action item for this area?',
  ];
}

export function fallbackCloseoutQuestions(areaCaptures: string[]): string[] {
  const captureLead = areaCaptures.length > 0
    ? `Review ${areaCaptures.length} captured area${areaCaptures.length === 1 ? '' : 's'} first: what should change?`
    : 'Did any area of the app feel confusing, broken, or too quiet?';
  return [
    captureLead,
    'What worked well enough to preserve?',
    'Where did the app make you wait or think too hard?',
    'Did proof match what you could see?',
    'Should any launched runtime be stopped or left running visibly?',
    'What should Majordomo remember for the next session?',
  ];
}

export function initialSurveyStatus(majordomoOnline: boolean): SurveyQuestionStatus {
  return majordomoOnline ? 'majordomo-loading' : 'fallback-visible';
}

export function timeoutSurveyStatus(secondsElapsed: number): SurveyQuestionStatus {
  return secondsElapsed >= 10 ? 'majordomo-timeout' : 'majordomo-loading';
}

export function buildSessionCloseoutPacket(input: SessionCloseoutPacket): SessionCloseoutPacket {
  return {
    ...input,
    surfaceIds: [...new Set(input.surfaceIds)].sort(),
    areaCaptures: [...input.areaCaptures],
  };
}

export function buildSessionCloseoutMarkdown(packet: SessionCloseoutPacket, questions: string[]): string {
  return [
    `# swarm-ui Closeout ${packet.sessionId}`,
    '',
    `Ended: ${packet.endedAt}`,
    `Trigger: ${packet.endKind}`,
    `App: ${packet.appIdentity.appName} ${packet.appIdentity.appVariant} v${packet.appIdentity.appVersion}`,
    `Run kind: ${packet.appIdentity.runKind}`,
    `Source root: ${packet.appIdentity.sourceRoot}`,
    `Project root: ${packet.projectRoot || 'none'}`,
    `Scope/channel: ${packet.scopeOrChannel || 'none'}`,
    `Majordomo cleanup: ${packet.majordomoRuntime.cleanupStatus}`,
    '',
    '## Captured Areas',
    '',
    ...(packet.areaCaptures.length ? packet.areaCaptures.map((entry) => `- ${entry}`) : ['- none']),
    '',
    '## Questions',
    '',
    ...questions.map((question) => `- [ ] ${question}`),
    '',
  ].join('\n');
}
