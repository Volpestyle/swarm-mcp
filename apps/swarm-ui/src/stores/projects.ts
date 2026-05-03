import { invoke } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';
import type {
  Position,
  ProjectBoundary,
  ProjectMembership,
  ProjectSpace,
  XYFlowNode,
} from '../lib/types';

type ProjectCatalog = {
  projects?: Partial<ProjectSpace>[];
  memberships?: Partial<ProjectMembership>[];
};

const DEFAULT_BOUNDARY = {
  x: 120,
  y: 120,
  width: 720,
  height: 420,
};

export const DEFAULT_PROJECT_COLOR = '#ffffff';

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeAdditionalRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => trimString(entry))
    .filter((entry) => entry.length > 0);
}

export function normalizeProjectColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PROJECT_COLOR;
  const trimmed = value.trim();
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if ((hex.length === 3 || hex.length === 6) && /^[0-9a-fA-F]+$/.test(hex)) {
    return `#${hex.toLowerCase()}`;
  }
  return DEFAULT_PROJECT_COLOR;
}

export function normalizeProjectSpace(value: Partial<ProjectSpace>): ProjectSpace | null {
  const id = trimString(value.id);
  const name = trimString(value.name);
  const root = trimString(value.root);
  if (!id || !name || !root) return null;

  const now = Date.now();
  return {
    id,
    name,
    root,
    color: normalizeProjectColor(value.color),
    additionalRoots: normalizeAdditionalRoots(value.additionalRoots),
    notes: trimString(value.notes),
    scope: trimString(value.scope) || null,
    boundary: {
      x: finiteNumber(value.boundary?.x, DEFAULT_BOUNDARY.x),
      y: finiteNumber(value.boundary?.y, DEFAULT_BOUNDARY.y),
      width: finiteNumber(value.boundary?.width, DEFAULT_BOUNDARY.width),
      height: finiteNumber(value.boundary?.height, DEFAULT_BOUNDARY.height),
    },
    createdAt: finiteNumber(value.createdAt, now),
    updatedAt: finiteNumber(value.updatedAt, now),
  };
}

export function normalizeProjectSpaces(value: Partial<ProjectSpace>[] | null | undefined): ProjectSpace[] {
  return (value ?? [])
    .map((project) => normalizeProjectSpace(project))
    .filter((project): project is ProjectSpace => project !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeProjectMembership(
  value: Partial<ProjectMembership>,
): ProjectMembership | null {
  const projectId = trimString(value.projectId);
  const instanceId = trimString(value.instanceId);
  if (!projectId || !instanceId) return null;

  return {
    projectId,
    instanceId,
    attachedAt: finiteNumber(value.attachedAt, Date.now()),
  };
}

export function normalizeProjectMemberships(
  value: Partial<ProjectMembership>[] | null | undefined,
): ProjectMembership[] {
  return (value ?? [])
    .map((membership) => normalizeProjectMembership(membership))
    .filter((membership): membership is ProjectMembership => membership !== null);
}

export function findProjectContainingPoint(
  point: Position,
  candidates: ProjectSpace[],
): ProjectSpace | null {
  return candidates.find((project) => {
    const { x, y, width, height } = project.boundary;
    return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  }) ?? null;
}

export function findProjectContainingNode(
  node: Pick<XYFlowNode, 'position' | 'width' | 'height'>,
  candidates: ProjectSpace[],
): ProjectSpace | null {
  const center = {
    x: node.position.x + (node.width ?? 0) / 2,
    y: node.position.y + (node.height ?? 0) / 2,
  };
  return findProjectContainingPoint(center, candidates);
}

export function findNodesInsideProject(
  project: ProjectSpace,
  nodes: Pick<XYFlowNode, 'id' | 'position' | 'width' | 'height'>[],
): Pick<XYFlowNode, 'id' | 'position' | 'width' | 'height'>[] {
  return nodes.filter((node) => findProjectContainingNode(node, [project])?.id === project.id);
}

export function projectMembershipTargetForNode(
  node: Pick<XYFlowNode, 'data'>,
): string | null {
  const instanceId = node.data?.instance?.id?.trim();
  if (instanceId) return instanceId;

  const browserContextId = node.data?.browserContext?.id?.trim();
  if (browserContextId) return `browser:${browserContextId}`;

  return null;
}

export function translateNodesWithMovedProject<
  T extends Pick<XYFlowNode, 'id' | 'position' | 'width' | 'height'>,
>(
  project: ProjectSpace,
  nextBoundary: ProjectBoundary,
  nodes: T[],
): T[] {
  const previousBoundary = project.boundary;
  if (
    previousBoundary.width !== nextBoundary.width ||
    previousBoundary.height !== nextBoundary.height
  ) {
    return nodes;
  }

  const dx = nextBoundary.x - previousBoundary.x;
  const dy = nextBoundary.y - previousBoundary.y;
  if (dx === 0 && dy === 0) return nodes;

  const containedNodeIds = new Set(findNodesInsideProject(project, nodes).map((node) => node.id));
  if (containedNodeIds.size === 0) return nodes;

  let changed = false;
  const translated = nodes.map((node) => {
    if (!containedNodeIds.has(node.id)) return node;
    const x = node.position?.x;
    const y = node.position?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return node;

    changed = true;
    return {
      ...node,
      position: {
        x: x + dx,
        y: y + dy,
      },
    };
  });

  return changed ? translated : nodes;
}

function applyProjectCatalog(catalog: ProjectCatalog): void {
  projects.set(catalog.projects ?? []);
  projectMemberships.set(catalog.memberships ?? []);
}

function createProjectsStore() {
  const { subscribe, set, update } = writable<ProjectSpace[]>([]);

  return {
    subscribe,
    set(projects: Partial<ProjectSpace>[]) {
      set(normalizeProjectSpaces(projects));
    },
    upsert(project: Partial<ProjectSpace>): ProjectSpace | null {
      const normalized = normalizeProjectSpace(project);
      if (!normalized) return null;

      update((current) => {
        const filtered = current.filter((entry) => entry.id !== normalized.id);
        return [...filtered, normalized].sort((left, right) => left.name.localeCompare(right.name));
      });
      return normalized;
    },
    remove(projectId: string): void {
      const id = projectId.trim();
      if (!id) return;
      update((current) => current.filter((project) => project.id !== id));
    },
    reset(): void {
      set([]);
    },
  };
}

function createProjectMembershipsStore() {
  const { subscribe, set, update } = writable<ProjectMembership[]>([]);

  return {
    subscribe,
    set(memberships: Partial<ProjectMembership>[]) {
      set(normalizeProjectMemberships(memberships));
    },
    attach(membership: Partial<ProjectMembership>): ProjectMembership | null {
      const normalized = normalizeProjectMembership(membership);
      if (!normalized) return null;

      update((current) => {
        const filtered = current.filter(
          (entry) =>
            entry.projectId !== normalized.projectId || entry.instanceId !== normalized.instanceId,
        );
        return [...filtered, normalized];
      });
      return normalized;
    },
    detach(projectId: string, instanceId: string): void {
      const trimmedProjectId = projectId.trim();
      const trimmedInstanceId = instanceId.trim();
      if (!trimmedProjectId || !trimmedInstanceId) return;

      update((current) =>
        current.filter(
          (entry) => entry.projectId !== trimmedProjectId || entry.instanceId !== trimmedInstanceId,
        ),
      );
    },
    reset(): void {
      set([]);
    },
  };
}

export const projects = createProjectsStore();
export const projectMemberships = createProjectMembershipsStore();

export async function loadProjects(): Promise<ProjectCatalog> {
  const catalog = await invoke<ProjectCatalog>('ui_list_projects');
  applyProjectCatalog(catalog);
  return catalog;
}

export async function saveProject(project: Partial<ProjectSpace>): Promise<ProjectSpace> {
  const normalized = normalizeProjectSpace({
    ...project,
    updatedAt: Date.now(),
    createdAt: project.createdAt ?? Date.now(),
  });
  if (!normalized) {
    throw new Error('project id, name, and root are required');
  }

  const saved = await invoke<ProjectSpace>('ui_save_project', { project: normalized });
  const resynced = normalizeProjectSpace(saved) ?? normalized;
  projects.upsert(resynced);
  return resynced;
}

export async function ensureProjectFolder(root: string): Promise<string> {
  const trimmed = root.trim();
  if (!trimmed) {
    throw new Error('Project root is required.');
  }
  return invoke<string>('ui_ensure_project_folder', { root: trimmed });
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const id = projectId.trim();
  if (!id) return false;
  const deleted = await invoke<boolean>('ui_delete_project', { projectId: id });
  if (deleted) {
    projects.remove(id);
    projectMemberships.set([]);
    await loadProjects();
  }
  return deleted;
}

export async function attachInstanceToProject(
  projectId: string,
  instanceId: string,
): Promise<ProjectMembership | null> {
  const normalized = normalizeProjectMembership({ projectId, instanceId });
  if (!normalized) return null;

  const saved = await invoke<ProjectMembership>('ui_attach_instance_to_project', {
    projectId: normalized.projectId,
    instanceId: normalized.instanceId,
  });
  const membership = normalizeProjectMembership(saved) ?? normalized;
  projectMemberships.attach(membership);
  return membership;
}

export async function detachInstanceFromProject(
  projectId: string,
  instanceId: string,
): Promise<boolean> {
  const normalized = normalizeProjectMembership({ projectId, instanceId });
  if (!normalized) return false;

  const deleted = await invoke<boolean>('ui_detach_instance_from_project', {
    projectId: normalized.projectId,
    instanceId: normalized.instanceId,
  });
  if (deleted) {
    projectMemberships.detach(normalized.projectId, normalized.instanceId);
  }
  return deleted;
}
