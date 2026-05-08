import { describe, expect, it } from 'bun:test';

import { resolveAgentSurfaceIcon } from './agentSurfaceIcons';

describe('agent surface icon resolver', () => {
  it('uses Chrome only for proven browser context', () => {
    expect(resolveAgentSurfaceIcon({ source: 'browser', path: 'https://example.com' }).kind).toBe('chrome');
  });

  it('uses Obsidian only when the source proves Obsidian', () => {
    expect(resolveAgentSurfaceIcon({ appId: 'obsidian', path: '/vault/Note.md' }).kind).toBe('obsidian');
  });

  it('uses Apple Notes for plain note document types', () => {
    expect(resolveAgentSurfaceIcon({ path: '/repo/README.md' }).kind).toBe('notes');
    expect(resolveAgentSurfaceIcon({ path: '/repo/spec.docx' }).kind).toBe('notes');
  });

  it('keeps unknown search and grep work generic', () => {
    expect(resolveAgentSurfaceIcon({ operation: 'grep', path: '' }).kind).toBe('project-folder');
  });
});
