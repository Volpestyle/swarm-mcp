import { describe, expect, it } from 'bun:test';

import { buildUiExportPayload } from './uiExport';

describe('buildUiExportPayload', () => {
  it('serializes nodes, edges, theme, and active scope', () => {
    const payload = buildUiExportPayload({
      activeScope: '/tmp/demo#overhaul',
      themeProfileId: 'tron-encom-os',
      nodes: [{ id: 'node-a', position: { x: 1, y: 2 } }],
      edges: [{ id: 'edge-a', source: 'node-a', target: 'node-b' }],
    });

    expect(payload.activeScope).toBe('/tmp/demo#overhaul');
    expect(payload.themeProfileId).toBe('tron-encom-os');
    expect(payload.nodes).toHaveLength(1);
    expect(payload.edges).toHaveLength(1);
    expect(payload.exportedAt).toMatch(/T/);
  });
});
