import { describe, expect, it } from 'bun:test';

import { normalizeProtocol } from './protocols';

describe('normalizeProtocol', () => {
  it('normalizes protocol nodes and edges', () => {
    const protocol = normalizeProtocol({
      id: 'protocol-1',
      projectId: 'project-1',
      name: 'Parallel Review',
      nodes: [{ id: 'planner', label: 'Planner', kind: 'agent-role' }],
      edges: [
        { id: 'edge-1', source: 'planner', target: 'reviewer', label: 'delegates' },
      ],
    });

    expect(protocol).not.toBeNull();
    expect(protocol?.id).toBe('protocol-1');
    expect(protocol?.projectId).toBe('project-1');
    expect(protocol?.name).toBe('Parallel Review');
    expect(protocol?.nodes).toHaveLength(1);
    expect(protocol?.nodes[0].kind).toBe('agent-role');
    expect(protocol?.edges).toHaveLength(1);
    expect(protocol?.edges[0].label).toBe('delegates');
  });

  it('defaults missing nodes / edges to empty arrays', () => {
    const protocol = normalizeProtocol({
      id: 'protocol-2',
      projectId: 'project-1',
      name: 'Empty Skeleton',
    });

    expect(protocol).not.toBeNull();
    expect(protocol?.nodes).toEqual([]);
    expect(protocol?.edges).toEqual([]);
  });

  it('trims whitespace on identity fields', () => {
    const protocol = normalizeProtocol({
      id: '  protocol-3  ',
      projectId: '  project-1  ',
      name: '  Trimmed  ',
    });

    expect(protocol?.id).toBe('protocol-3');
    expect(protocol?.projectId).toBe('project-1');
    expect(protocol?.name).toBe('Trimmed');
  });

  it('returns null when id is missing', () => {
    expect(normalizeProtocol({ projectId: 'project-1', name: 'No Id' })).toBeNull();
  });

  it('returns null when projectId is missing', () => {
    expect(normalizeProtocol({ id: 'protocol-4', name: 'No Project' })).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(normalizeProtocol({ id: 'protocol-5', projectId: 'project-1' })).toBeNull();
  });

  it('returns null when identity fields are blank strings', () => {
    expect(
      normalizeProtocol({ id: '   ', projectId: 'project-1', name: 'Blank Id' }),
    ).toBeNull();
    expect(
      normalizeProtocol({ id: 'protocol-6', projectId: '   ', name: 'Blank Project' }),
    ).toBeNull();
    expect(
      normalizeProtocol({ id: 'protocol-7', projectId: 'project-1', name: '   ' }),
    ).toBeNull();
  });
});
