import type { BindingState, PtySession } from './types';

export interface PtyCatalogReconcileResult {
  sessionMap: Map<string, PtySession>;
  bindings: BindingState;
  removedPtyIds: string[];
}

export function reconcilePtyCatalog(
  currentSessions: Map<string, PtySession>,
  nextBindings: BindingState,
  nextSessions: PtySession[],
): PtyCatalogReconcileResult {
  const sessionMap = new Map(nextSessions.map((session) => [session.id, session]));
  const livePtyIds = new Set(sessionMap.keys());
  const removedPtyIds = [...currentSessions.keys()].filter((ptyId) => !livePtyIds.has(ptyId));

  return {
    sessionMap,
    bindings: {
      pending: nextBindings.pending.filter(([, ptyId]) => livePtyIds.has(ptyId)),
      resolved: nextBindings.resolved.filter(([, ptyId]) => livePtyIds.has(ptyId)),
    },
    removedPtyIds,
  };
}
