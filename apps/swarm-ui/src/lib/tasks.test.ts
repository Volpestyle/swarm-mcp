import { describe, expect, it } from 'bun:test';

import type { Task } from './types';
import { buildTaskTree } from './tasks';

function makeTask(id: string, parent_task_id: string | null = null): Task {
  return {
    id,
    scope: 's',
    type: 'implement',
    title: `task ${id}`,
    description: null,
    requester: 'r',
    assignee: 'a',
    status: 'open',
    files: [],
    result: null,
    created_at: 0,
    updated_at: 0,
    changed_at: 0,
    priority: 0,
    depends_on: [],
    parent_task_id,
  };
}

function indexBy(items: Task[]): Map<string, Task> {
  return new Map(items.map((t) => [t.id, t]));
}

describe('buildTaskTree', () => {
  it('returns a flat list when no tasks have parents', () => {
    const items = [makeTask('a'), makeTask('b')];
    const tree = buildTaskTree(items, indexBy(items));
    expect(tree).toHaveLength(2);
    expect(tree.every((row) => row.depth === 0)).toBe(true);
    expect(tree.every((row) => row.externalParent === null)).toBe(true);
  });

  it('nests children under parents present in the same list', () => {
    const parent = makeTask('p');
    const child = makeTask('c', 'p');
    const items = [parent, child];
    const tree = buildTaskTree(items, indexBy(items));
    expect(tree.map((r) => [r.task.id, r.depth])).toEqual([
      ['p', 0],
      ['c', 1],
    ]);
  });

  it('flags parents that exist globally but not in the list', () => {
    const parent = makeTask('p');
    const child = makeTask('c', 'p');
    const all = indexBy([parent, child]);
    const tree = buildTaskTree([child], all);
    expect(tree).toHaveLength(1);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].externalParent?.id).toBe('p');
  });

  it('treats unknown parent ids as no parent', () => {
    const child = makeTask('c', 'missing');
    const tree = buildTaskTree([child], indexBy([child]));
    expect(tree[0].depth).toBe(0);
    expect(tree[0].externalParent).toBeNull();
  });

  it('handles multiple levels of nesting', () => {
    const items = [
      makeTask('grandparent'),
      makeTask('parent', 'grandparent'),
      makeTask('child', 'parent'),
    ];
    const tree = buildTaskTree(items, indexBy(items));
    expect(tree.map((r) => [r.task.id, r.depth])).toEqual([
      ['grandparent', 0],
      ['parent', 1],
      ['child', 2],
    ]);
  });
});
