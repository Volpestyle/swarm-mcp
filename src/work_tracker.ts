import * as kv from "./kv";

export const WORK_TRACKER_PREFIX = "config/work_tracker/";

export function identityFromLabel(label: string | null | undefined) {
  if (!label) return "";
  for (const token of label.split(/\s+/)) {
    if (!token.startsWith("identity:")) continue;
    const identity = token.slice("identity:".length).trim();
    if (/^[A-Za-z0-9_.-]+$/.test(identity)) return identity;
  }
  return "";
}

export function workTrackerKey(identity: string | null | undefined) {
  const clean = (identity ?? "").trim();
  const suffix = /^[A-Za-z0-9_.-]+$/.test(clean) ? clean : "default";
  return `${WORK_TRACKER_PREFIX}${suffix}`;
}

function parseValue(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function configuredWorkTracker(scope: string, label: string | null | undefined) {
  const identity = identityFromLabel(label);
  const keys = identity
    ? [workTrackerKey(identity), workTrackerKey("default")]
    : [workTrackerKey("default")];

  for (const key of keys) {
    const row = kv.get(scope, key);
    if (!row) continue;
    return {
      key,
      value: parseValue(row.value),
      updated_at: row.updated_at,
    };
  }

  return null;
}
