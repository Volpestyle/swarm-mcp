import { describe, expect, it } from 'bun:test';
import {
  findNodesInsideProject,
  findProjectContainingPoint,
  normalizeProjectSpace,
  projectMembershipTargetForNode,
  translateNodesWithMovedProject,
} from './projects';

describe('normalizeProjectSpace', () => {
  it('normalizes a project with boundary geometry and roots', () => {
    const project = normalizeProjectSpace({
      id: ' project-alpha ',
      name: ' Alpha ',
      root: ' /Users/mathewfrazier/Desktop/Alpha ',
      additionalRoots: [' /Users/mathewfrazier/Desktop/Alpha/assets ', '', '  '],
      notes: ' Keep the visual north star close. ',
      boundary: { x: 10, y: 20, width: 800, height: 500 },
      createdAt: 100,
      updatedAt: 200,
    });

    expect(project?.id).toBe('project-alpha');
    expect(project?.name).toBe('Alpha');
    expect(project?.root).toBe('/Users/mathewfrazier/Desktop/Alpha');
    expect(project?.color).toBe('#ffffff');
    expect(project?.boundary.width).toBe(800);
    expect(project?.additionalRoots).toEqual(['/Users/mathewfrazier/Desktop/Alpha/assets']);
    expect(project?.notes).toBe('Keep the visual north star close.');
    expect(project?.createdAt).toBe(100);
    expect(project?.updatedAt).toBe(200);
  });

  it('normalizes project colors to hex and falls back to Tron white', () => {
    expect(normalizeProjectSpace({
      id: 'project-alpha',
      name: 'Alpha',
      root: '/tmp/alpha',
      color: ' 35F2FF ',
    })?.color).toBe('#35f2ff');

    expect(normalizeProjectSpace({
      id: 'project-beta',
      name: 'Beta',
      root: '/tmp/beta',
      color: 'hotpink',
    })?.color).toBe('#ffffff');
  });

  it('rejects missing required identity fields', () => {
    expect(normalizeProjectSpace({ id: 'project-alpha', name: 'Alpha' })).toBeNull();
    expect(normalizeProjectSpace({ id: 'project-alpha', root: '/tmp/alpha' })).toBeNull();
    expect(normalizeProjectSpace({ name: 'Alpha', root: '/tmp/alpha' })).toBeNull();
  });
});

describe('findNodesInsideProject', () => {
  it('returns nodes whose centers are inside a project boundary', () => {
    const project = normalizeProjectSpace({
      id: 'project-alpha',
      name: 'Alpha',
      root: '/tmp/alpha',
      boundary: { x: 100, y: 100, width: 500, height: 300 },
    });

    expect(project).not.toBeNull();
    const matches = findNodesInsideProject(project!, [
      { id: 'inside', position: { x: 160, y: 180 }, width: 220, height: 160 },
      { id: 'outside', position: { x: 20, y: 20 }, width: 80, height: 80 },
    ]);

    expect(matches.map((node) => node.id)).toEqual(['inside']);
  });
});

describe('findProjectContainingPoint', () => {
  it('returns the first project containing the point', () => {
    const project = normalizeProjectSpace({
      id: 'project-alpha',
      name: 'Alpha',
      root: '/tmp/alpha',
      boundary: { x: 10, y: 20, width: 800, height: 500 },
    });

    expect(project).not.toBeNull();
    const match = findProjectContainingPoint(
      { x: 400, y: 300 },
      project ? [project] : [],
    );

    expect(match?.id).toBe('project-alpha');
    expect(findProjectContainingPoint({ x: 900, y: 300 }, project ? [project] : [])).toBeNull();
  });
});

describe('projectMembershipTargetForNode', () => {
  it('uses the instance id for agent nodes', () => {
    expect(projectMembershipTargetForNode({
      data: {
        instance: { id: 'agent-1' },
        browserContext: null,
      },
    } as never)).toBe('agent-1');
  });

  it('uses a browser-prefixed id for managed browser nodes', () => {
    expect(projectMembershipTargetForNode({
      data: {
        instance: null,
        browserContext: { id: 'ctx-1' },
      },
    } as never)).toBe('browser:ctx-1');
  });

  it('returns null for nodes with no shareable project target', () => {
    expect(projectMembershipTargetForNode({ data: {} } as never)).toBeNull();
  });
});

describe('translateNodesWithMovedProject', () => {
  it('moves nodes inside the original boundary by the project move delta', () => {
    const project = normalizeProjectSpace({
      id: 'project-alpha',
      name: 'Alpha',
      root: '/tmp/alpha',
      boundary: { x: 100, y: 100, width: 500, height: 300 },
    });

    expect(project).not.toBeNull();
    const nodes = [
      { id: 'inside', position: { x: 160, y: 180 }, width: 220, height: 160 },
      { id: 'outside', position: { x: 20, y: 20 }, width: 80, height: 80 },
    ];

    const moved = translateNodesWithMovedProject(
      project!,
      { x: 150, y: 70, width: 500, height: 300 },
      nodes,
    );

    expect(moved.find((node) => node.id === 'inside')?.position).toEqual({ x: 210, y: 150 });
    expect(moved.find((node) => node.id === 'outside')?.position).toEqual({ x: 20, y: 20 });
  });

  it('does not move enclosed nodes when the project boundary is resized', () => {
    const project = normalizeProjectSpace({
      id: 'project-alpha',
      name: 'Alpha',
      root: '/tmp/alpha',
      boundary: { x: 100, y: 100, width: 500, height: 300 },
    });

    expect(project).not.toBeNull();
    const nodes = [
      { id: 'inside', position: { x: 160, y: 180 }, width: 220, height: 160 },
    ];

    const moved = translateNodesWithMovedProject(
      project!,
      { x: 120, y: 100, width: 480, height: 300 },
      nodes,
    );

    expect(moved[0]?.position).toEqual({ x: 160, y: 180 });
  });
});
