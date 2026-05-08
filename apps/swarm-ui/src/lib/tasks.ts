// =============================================================================
// tasks.ts — task hierarchy helpers
//
// `parent_task_id` already comes across in the snapshot but is rendered flat
// today. This builds an ordered, depth-tagged tree from a subset of tasks
// so the Inspector lists can show subtasks indented under parents — and
// flag tasks whose parent lives outside the current subset with a
// breadcrumb hint.
// =============================================================================

import type { Task } from './types';

export interface TaskTreeRow {
  task: Task;
  depth: number;
  /**
   * Parent task that lives in the global task map but NOT in the current
   * list (e.g. shown in "Assigned Tasks" but the parent is assigned to a
   * different instance). Used to render a "↑ parent: ..." breadcrumb so
   * the user can still see the relationship.
   */
  externalParent: Task | null;
}

/**
 * Sort `items` into a tree-ordered list of rows. Children that exist in
 * `items` render under their parent with `depth > 0`. Children whose
 * parent is in `allTasks` but missing from `items` get rendered at the
 * top with `externalParent` set to the orphan parent.
 *
 * Stable: relative order between siblings preserves the input order, so
 * callers can pre-sort `items` (by priority, status, created_at) and
 * trust the tree layout to follow.
 */
export function buildTaskTree(
  items: readonly Task[],
  allTasks: Map<string, Task>,
): TaskTreeRow[] {
  const itemIds = new Set(items.map((t) => t.id));
  const childMap = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const task of items) {
    const parentId = task.parent_task_id;
    if (parentId && itemIds.has(parentId)) {
      const list = childMap.get(parentId);
      if (list) list.push(task);
      else childMap.set(parentId, [task]);
    } else {
      roots.push(task);
    }
  }

  const out: TaskTreeRow[] = [];
  const visited = new Set<string>();

  const walk = (task: Task, depth: number): void => {
    if (visited.has(task.id)) return; // guard against accidental cycles
    visited.add(task.id);

    const parentId = task.parent_task_id;
    const externalParent =
      parentId && !itemIds.has(parentId) ? allTasks.get(parentId) ?? null : null;

    out.push({ task, depth, externalParent });

    const children = childMap.get(task.id);
    if (children) {
      for (const child of children) walk(child, depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return out;
}
