// =============================================================================
// protocols.ts — protocol domain model helpers (Phase 7 Task 3)
//
// A "protocol" describes how a team of agents collaborates: who delegates to
// whom, where approvals gate, which tasks depend on which assets. Protocols
// live separate from the live agent graph so the main canvas stays readable
// (see Phase 7 plan and ProtocolView.svelte / ProtocolEditor.svelte in Task 4).
//
// This module is deliberately small: a single `normalizeProtocol` that takes a
// loosely-typed payload (the shape we expect from KV / IPC / file imports) and
// returns a fully-typed `ProjectProtocol` or `null` if the required identity
// fields are missing. The Phase 7 plan's TDD test in protocols.test.ts pins
// the contract.
// =============================================================================

import type { ProjectProtocol } from './types';

export function normalizeProtocol(
  value: Partial<ProjectProtocol>,
): ProjectProtocol | null {
  const id = value.id?.trim();
  const projectId = value.projectId?.trim();
  const name = value.name?.trim();
  if (!id || !projectId || !name) {
    return null;
  }
  return {
    id,
    projectId,
    name,
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
  };
}
