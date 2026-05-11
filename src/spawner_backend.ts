export type SpawnPlacement = {
  workspace?: string | null;
  tab?: string | null;
  group?: string | null;
  parent_pane_id?: string | null;
  split_direction?: string | null;
  max_panes_per_tab?: number | null;
};

export type SpawnRequest = {
  scope: string;
  requester: string;
  cwd: string;
  role: string;
  harness: string;
  identity?: string | null;
  label?: string | null;
  name?: string | null;
  launch_token: string;
  lock_path: string;
  lock_note: Record<string, unknown>;
  wait_seconds: number;
  placement?: SpawnPlacement | null;
  on_ready_to_prompt?: (ready: SpawnReady) => void;
};

export type SpawnReady = {
  expected_instance?: string | null;
  spawned_instance?: string | null;
  workspace_handle?: unknown;
  launch_token?: string | null;
};

export type SpawnResult = Record<string, unknown> & {
  status: "spawned" | "spawn_in_flight" | "spawn_failed";
  spawned_instance?: string | null;
};

export type SpawnerBackend = {
  name: string;
  defaultWaitSeconds: number;
  defaultHarness(): string;
  spawn(input: SpawnRequest): Promise<SpawnResult> | SpawnResult;
};

const spawners = new Map<string, SpawnerBackend>();

export function normalizeSpawnerName(value: string | undefined) {
  const normalized = (value ?? "herdr").trim().toLowerCase().replace(/_/g, "-");
  return normalized === "ui" ? "swarm-ui" : normalized;
}

export function registerSpawner(backend: SpawnerBackend) {
  const name = normalizeSpawnerName(backend.name);
  if (!name) throw new Error("Spawner backend name is required");
  spawners.set(name, { ...backend, name });
}

export function requireSpawner(name: string | undefined) {
  const normalized = normalizeSpawnerName(
    name ?? process.env.SWARM_SPAWNER ?? process.env.SWARM_DISPATCH_SPAWNER,
  );
  const backend = spawners.get(normalized);
  if (backend) return backend;

  const registered = Array.from(spawners.keys()).sort();
  const suffix = registered.length
    ? ` Registered spawners: ${registered.join(", ")}.`
    : " No spawner backends are registered.";
  throw new Error(`Unknown dispatch spawner "${normalized}".${suffix}`);
}

export function registeredSpawners() {
  return Array.from(spawners.values());
}

export function clearSpawnersForTesting() {
  spawners.clear();
}
