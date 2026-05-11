import { db } from "./db";
import * as messages from "./messages";
import * as planner from "./planner";
import * as registry from "./registry";
import * as tasks from "./tasks";
import type { Instance } from "./registry";
import type { TaskStatus } from "./tasks";

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "open",
  "claimed",
  "in_progress",
  "blocked",
  "approval_required",
]);

const CLAIMABLE_TASK_STATUSES = new Set<TaskStatus>(["open", "claimed"]);

type TaskRow = Record<string, unknown> & {
  id: string;
  type: string;
  title: string;
  status: TaskStatus;
  assignee: string | null;
  requester: string;
  priority: number;
  files?: string[] | null;
  depends_on?: string[] | null;
  parent_task_id?: string | null;
  review_of_task_id?: string | null;
  fixes_task_id?: string | null;
  progress_summary?: string | null;
  progress_updated_at?: number | null;
  blocked_reason?: string | null;
  expected_next_update_at?: number | null;
};

type LockRow = {
  id: string;
  instance_id: string;
  file: string;
  content: string;
  task_id: string | null;
  created_at: number;
};

type Warning = {
  code: string;
  severity: "info" | "warning";
  message: string;
  task_id?: string;
  file?: string;
  instance_id?: string;
};

function taskFiles(task: TaskRow) {
  return Array.isArray(task.files) ? task.files.filter((f) => typeof f === "string") : [];
}

function taskSummary(task: TaskRow) {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    requester: task.requester,
    priority: task.priority,
    files: taskFiles(task),
    depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
    parent_task_id: task.parent_task_id ?? null,
    review_of_task_id: task.review_of_task_id ?? null,
    fixes_task_id: task.fixes_task_id ?? null,
    progress_summary: task.progress_summary ?? null,
    progress_updated_at: task.progress_updated_at ?? null,
    blocked_reason: task.blocked_reason ?? null,
    expected_next_update_at: task.expected_next_update_at ?? null,
  };
}

function warningCollector() {
  const seen = new Set<string>();
  const warnings: Warning[] = [];
  return {
    add(warning: Warning) {
      const key = [warning.code, warning.task_id, warning.file, warning.instance_id].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      warnings.push(warning);
    },
    warnings,
  };
}

function locks(scope: string, visiblePeerIds: Set<string>, instanceId: string) {
  const rows = db
    .query(
      `SELECT id, instance_id, file, content, task_id, created_at
       FROM context
       WHERE scope = ? AND type = 'lock'
       ORDER BY created_at DESC, id DESC`,
    )
    .all(scope) as LockRow[];

  return rows.filter((row) => row.instance_id === instanceId || visiblePeerIds.has(row.instance_id));
}

function nextAction(args: {
  unreadCount: number;
  assignedClaimed: TaskRow[];
  assignedInProgress: TaskRow[];
  claimable: TaskRow[];
  role: string | null;
  taskCounts: Record<TaskStatus, number>;
}) {
  if (args.unreadCount > 0) {
    return {
      tool: "poll_messages",
      reason: `Read ${args.unreadCount} unread message(s) before claiming new work.`,
    };
  }

  if (args.assignedInProgress.length > 0) {
    return {
      tool: "complete_task",
      task_id: args.assignedInProgress[0].id,
      reason:
        "Continue current in-progress work. Use report_progress for long-running or blocked work, then complete_task when done.",
    };
  }

  if (args.assignedClaimed.length > 0) {
    return {
      tool: "claim_task",
      task_id: args.assignedClaimed[0].id,
      reason: "Start the highest-priority task already assigned to you.",
    };
  }

  if (args.claimable.length > 0) {
    return {
      tool: "claim_next_task",
      task_id: args.claimable[0].id,
      reason: "Claim the highest-priority compatible open task in one step.",
    };
  }

  if (
    args.role === "planner" &&
    (args.taskCounts.failed > 0 ||
      args.taskCounts.cancelled > 0 ||
      args.taskCounts.approval_required > 0)
  ) {
    return {
      tool: "list_tasks",
      reason: "Planner should inspect failed, cancelled, or approval-required tasks.",
    };
  }

  return {
    tool: "wait_for_activity",
    reason: "No immediate work is ready; wait only if you still own active monitoring responsibility.",
  };
}

export function buildStatus(instance: Instance) {
  registry.prune();

  const scope = instance.scope;
  const role = planner.extractRole(instance.label);
  const peers = registry.listVisible(instance).filter((item) => item.id !== instance.id);
  const visiblePeerIds = new Set(peers.map((peer) => peer.id));
  const unread = messages.peek(instance.id, scope, 50);
  const allTasks = tasks.list(scope, { viewer: instance }) as TaskRow[];
  const allLocks = locks(scope, visiblePeerIds, instance.id);
  const heldLocks = allLocks.filter((lock) => lock.instance_id === instance.id);
  const peerLocks = allLocks.filter((lock) => lock.instance_id !== instance.id);
  const taskCounts = Object.fromEntries(
    tasks.TASK_STATUSES.map((status) => [
      status,
      allTasks.filter((task) => task.status === status).length,
    ]),
  ) as Record<TaskStatus, number>;

  const assignedTasks = allTasks.filter(
    (task) => task.assignee === instance.id && ACTIVE_TASK_STATUSES.has(task.status),
  );
  const assignedClaimed = assignedTasks.filter((task) => task.status === "claimed");
  const assignedInProgress = assignedTasks.filter((task) => task.status === "in_progress");
  const claimableTasks = allTasks
    .filter(
      (task) =>
        CLAIMABLE_TASK_STATUSES.has(task.status) &&
        ((task.status === "open" && task.assignee === null) ||
          (task.status === "claimed" && task.assignee === instance.id)),
    )
    .sort((a, b) => {
      const assignedRank = Number(b.status === "claimed" && b.assignee === instance.id) -
        Number(a.status === "claimed" && a.assignee === instance.id);
      if (assignedRank !== 0) return assignedRank;
      return b.priority - a.priority;
    });
  const activeTasksByOthers = allTasks.filter(
    (task) =>
      task.assignee &&
      task.assignee !== instance.id &&
      (task.status === "claimed" || task.status === "in_progress"),
  );

  const collector = warningCollector();
  const currentTime = Math.floor(Date.now() / 1000);
  const blockingLocks: Array<LockRow & { task_id: string }> = [];
  const activeFiles = new Set<string>();
  const relevantTasks = Array.from(
    new Map([...assignedTasks, ...claimableTasks].map((task) => [task.id, task])).values(),
  );

  for (const task of relevantTasks) {
    const files = taskFiles(task);

    if (task.status === "in_progress" && task.blocked_reason) {
      collector.add({
        code: "task_reported_blocked",
        severity: "warning",
        task_id: task.id,
        message: `This task reports blocked progress: ${task.blocked_reason}`,
      });
    }

    if (
      task.status === "in_progress" &&
      typeof task.expected_next_update_at === "number" &&
      task.expected_next_update_at < currentTime
    ) {
      collector.add({
        code: "expected_progress_update_overdue",
        severity: "info",
        task_id: task.id,
        message:
          "This task's expected next progress update time has passed. Report progress or complete the task.",
      });
    }

    if (task.status === "in_progress" && peers.length > 0 && files.length > 0) {
      const missing = files.filter(
        (file) => !heldLocks.some((lock) => lock.file === file),
      );
      for (const file of missing) {
        collector.add({
          code: "missing_lock_for_in_progress_task",
          severity: "warning",
          task_id: task.id,
          file,
          message:
            "You have an in-progress task touching this file, but no lock from your instance is recorded.",
        });
      }
    }

    if (files.length === 0 && task.status === "in_progress" && peers.length > 0) {
      collector.add({
        code: "in_progress_task_without_files",
        severity: "info",
        task_id: task.id,
        message:
          "This in-progress task has no files listed, so peers cannot detect file-level collisions from task metadata.",
      });
    }

    for (const file of files) {
      activeFiles.add(file);
      for (const lock of peerLocks.filter((item) => item.file === file)) {
        blockingLocks.push({ ...lock, task_id: task.id });
        collector.add({
          code: "file_locked_by_peer",
          severity: "warning",
          task_id: task.id,
          file,
          instance_id: lock.instance_id,
          message: "A peer currently holds a lock on a file relevant to this task.",
        });
      }

      for (const other of activeTasksByOthers) {
        if (!taskFiles(other).includes(file)) continue;
        collector.add({
          code: "active_task_file_overlap",
          severity: "warning",
          task_id: task.id,
          file,
          instance_id: other.assignee ?? undefined,
          message:
            "Another active task references the same file. Coordinate before editing.",
        });
      }
    }
  }

  for (const other of activeTasksByOthers) {
    if (
      other.status === "in_progress" &&
      typeof other.expected_next_update_at === "number" &&
      other.expected_next_update_at < currentTime
    ) {
      collector.add({
        code: "peer_progress_update_overdue",
        severity: "info",
        task_id: other.id,
        instance_id: other.assignee ?? undefined,
        message:
          "A peer task's expected next progress update time has passed. Check the task before interrupting the peer.",
      });
    }
  }

  for (const lock of heldLocks) {
    if (activeFiles.has(lock.file)) continue;
    collector.add({
      code: "held_lock_without_active_task_file",
      severity: "info",
      file: lock.file,
      message:
        "You hold a lock that is not tied to your current assigned/claimable task files. Release it if you no longer need it.",
    });
  }

  const owner = planner.getOwner(scope);

  return {
    instance: {
      id: instance.id,
      label: instance.label,
      role,
      scope,
      directory: instance.directory,
      file_root: instance.file_root,
    },
    peers,
    planner_owner: owner
      ? {
          ...owner,
          is_me: owner.instance_id === instance.id,
        }
      : null,
    unread_messages: unread,
    task_counts: taskCounts,
    assigned_tasks: assignedTasks.map(taskSummary),
    claimable_tasks: claimableTasks.slice(0, 10).map(taskSummary),
    active_peer_tasks: activeTasksByOthers.slice(0, 20).map(taskSummary),
    held_locks: heldLocks,
    blocking_locks: blockingLocks,
    warnings: collector.warnings,
    next_action: nextAction({
      unreadCount: unread.length,
      assignedClaimed,
      assignedInProgress,
      claimable: claimableTasks,
      role,
      taskCounts,
    }),
  };
}
