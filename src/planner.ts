import { db } from "./db";
import * as kv from "./kv";
import { stamp } from "./time";

export const PLANNER_OWNER_KEY = "owner/planner";

type PlannerInstance = {
  id: string;
  scope: string;
  label: string | null;
};

type PlannerOwner = {
  instance_id: string;
  label: string | null;
  assigned_at: number;
};

export function hasRole(label: string | null | undefined, role: string) {
  if (!label) return false;
  return label.split(/\s+/).includes(`role:${role}`);
}

function ownerEntry(scope: string) {
  const entry = kv.get(scope, PLANNER_OWNER_KEY);
  if (!entry) return { raw: null, owner: null as PlannerOwner | null };

  try {
    const parsed = JSON.parse(entry.value) as Partial<PlannerOwner>;
    if (typeof parsed.instance_id !== "string") {
      return { raw: entry, owner: null as PlannerOwner | null };
    }

    return {
      raw: entry,
      owner: {
        instance_id: parsed.instance_id,
        label: typeof parsed.label === "string" ? parsed.label : null,
        assigned_at:
          typeof parsed.assigned_at === "number" ? parsed.assigned_at : 0,
      },
    };
  } catch {
    return { raw: entry, owner: null as PlannerOwner | null };
  }
}

function activePlanner(scope: string, id: string) {
  const row = db
    .query("SELECT id, scope, label FROM instances WHERE id = ? AND scope = ?")
    .get(id, scope) as PlannerInstance | null;

  if (!row || !hasRole(row.label, "planner")) return null;
  return row;
}

function nextPlanner(scope: string, excludeId?: string) {
  const rows = db
    .query(
      "SELECT id, scope, label FROM instances WHERE scope = ? ORDER BY registered_at ASC, id ASC",
    )
    .all(scope) as PlannerInstance[];

  return (
    rows.find(
      (row) => row.id !== excludeId && hasRole(row.label, "planner"),
    ) ?? null
  );
}

function writeOwner(scope: string, instance: PlannerInstance) {
  kv.set(
    scope,
    PLANNER_OWNER_KEY,
    JSON.stringify({
      instance_id: instance.id,
      label: instance.label ?? null,
      assigned_at: stamp(),
    }),
  );
}

export function getOwner(scope: string) {
  const current = ownerEntry(scope);
  if (!current.owner) return null;
  return activePlanner(scope, current.owner.instance_id) ? current.owner : null;
}

export function ensureOwner(instance: PlannerInstance) {
  if (!hasRole(instance.label, "planner")) {
    return { owner_id: null as string | null, acquired: false };
  }

  const current = ownerEntry(instance.scope);
  if (current.owner?.instance_id === instance.id) {
    return { owner_id: instance.id, acquired: false };
  }

  const active = current.owner
    ? activePlanner(instance.scope, current.owner.instance_id)
    : null;
  if (active) {
    return { owner_id: active.id, acquired: false };
  }

  writeOwner(instance.scope, instance);
  return { owner_id: instance.id, acquired: true };
}

export function refreshOwner(scope: string) {
  const current = ownerEntry(scope);
  if (current.owner) {
    const active = activePlanner(scope, current.owner.instance_id);
    if (active) return { owner_id: active.id, changed: false };
  }

  const successor = nextPlanner(scope);
  if (successor) {
    writeOwner(scope, successor);
    return { owner_id: successor.id, changed: true };
  }

  if (current.raw) kv.del(scope, PLANNER_OWNER_KEY);
  return { owner_id: null as string | null, changed: !!current.raw };
}
