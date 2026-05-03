import { invoke } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';
import type {
  AssetAttachment,
  AssetKind,
  ProjectAsset,
  ProjectInventoryCategory,
  ProjectInventoryEntry,
  ProjectInventoryEntryType,
} from '../lib/types';

export type ProjectAssetCatalog = {
  assets?: Partial<ProjectAsset>[];
  attachments?: Partial<AssetAttachment>[];
  importedCount?: number;
  scannedRoots?: string[];
  inventory?: Partial<ProjectInventoryEntry>[];
};

const ASSET_KINDS: AssetKind[] = ['image', 'screenshot', 'note', 'folder', 'protocol', 'reference'];
const TARGET_TYPES: AssetAttachment['targetType'][] = ['agent', 'project', 'protocol'];
const INVENTORY_ENTRY_TYPES: ProjectInventoryEntryType[] = ['file', 'folder', 'symlink', 'other'];
const INVENTORY_CATEGORIES: ProjectInventoryCategory[] = [
  'folder',
  'image',
  'richText',
  'text',
  'code',
  'document',
  'archive',
  'media',
  'file',
  'symlink',
  'other',
];

const INVENTORY_CATEGORY_LABELS: Record<ProjectInventoryCategory, string> = {
  folder: 'Folders',
  image: 'Images',
  richText: 'Rich Text',
  text: 'Text',
  code: 'Code',
  document: 'Documents',
  archive: 'Archives',
  media: 'Media',
  file: 'Files',
  symlink: 'Links',
  other: 'Other',
};

export type ProjectInventoryDisplay =
  | { mode: 'list'; items: ProjectInventoryEntry[]; groups?: undefined }
  | { mode: 'grouped'; items?: undefined; groups: { category: ProjectInventoryCategory; label: string; count: number }[] };

export const LINKED_ASSETS_FOLDER_PATH = 'virtual:linked-assets';

export type ProjectFileBubbleFolder = {
  path: string;
  name: string;
  root: string;
  source: 'root' | 'inventory' | 'asset' | 'linked';
};

export type ProjectFileBubbleItem = {
  path: string;
  name: string;
  category: string;
  entryType: string;
  extension: string;
  sizeBytes: number | null;
  assetId: string | null;
  assetKind: AssetKind | null;
  content: string | null;
  description: string;
  isImage: boolean;
};

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeProjectAsset(value: Partial<ProjectAsset>): ProjectAsset | null {
  const id = trimString(value.id);
  const projectId = trimString(value.projectId);
  const title = trimString(value.title);
  const kind = value.kind && ASSET_KINDS.includes(value.kind) ? value.kind : null;
  if (!id || !projectId || !title || !kind) return null;

  const now = Date.now();
  return {
    id,
    projectId,
    kind,
    title,
    path: trimString(value.path) || null,
    content: trimString(value.content) || null,
    description: trimString(value.description),
    createdAt: finiteNumber(value.createdAt, now),
    updatedAt: finiteNumber(value.updatedAt, now),
  };
}

export function normalizeProjectAssets(
  value: Partial<ProjectAsset>[] | null | undefined,
): ProjectAsset[] {
  return (value ?? [])
    .map((asset) => normalizeProjectAsset(asset))
    .filter((asset): asset is ProjectAsset => asset !== null)
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function normalizeProjectInventoryEntry(
  value: Partial<ProjectInventoryEntry>,
): ProjectInventoryEntry | null {
  const projectId = trimString(value.projectId);
  const root = trimString(value.root);
  const path = trimString(value.path);
  const name = trimString(value.name);
  const entryType = value.entryType && INVENTORY_ENTRY_TYPES.includes(value.entryType)
    ? value.entryType
    : null;
  const category = value.category && INVENTORY_CATEGORIES.includes(value.category)
    ? value.category
    : null;
  if (!projectId || !root || !path || !name || !entryType || !category) return null;

  return {
    projectId,
    root,
    path,
    name,
    entryType,
    category,
    extension: trimString(value.extension).toLowerCase(),
    sizeBytes: typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes)
      ? value.sizeBytes
      : null,
    modifiedAt: finiteNumber(value.modifiedAt, 0),
  };
}

export function normalizeProjectInventory(
  value: Partial<ProjectInventoryEntry>[] | null | undefined,
): ProjectInventoryEntry[] {
  return (value ?? [])
    .map((entry) => normalizeProjectInventoryEntry(entry))
    .filter((entry): entry is ProjectInventoryEntry => entry !== null)
    .sort((left, right) => {
      const leftRank = left.entryType === 'folder' ? 0 : 1;
      const rightRank = right.entryType === 'folder' ? 0 : 1;
      return leftRank - rightRank || left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
    });
}

export function projectInventoryDisplay(entries: ProjectInventoryEntry[]): ProjectInventoryDisplay {
  if (entries.length <= 8) {
    return { mode: 'list', items: entries };
  }
  const counts = new Map<ProjectInventoryCategory, number>();
  for (const entry of entries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .map(([category, count]) => ({
      category,
      label: INVENTORY_CATEGORY_LABELS[category],
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return { mode: 'grouped', groups };
}

export function projectInventoryDirectChildren(
  entries: ProjectInventoryEntry[],
  folderPath: string,
): ProjectInventoryEntry[] {
  const folder = folderPath.trim().replace(/\/+$/, '');
  if (!folder) return [];
  const prefix = `${folder}/`;
  return entries
    .filter((entry) => {
      if (entry.path === folder || !entry.path.startsWith(prefix)) return false;
      return !entry.path.slice(prefix.length).includes('/');
    })
    .sort((left, right) => {
      const leftRank = left.entryType === 'folder' ? 0 : 1;
      const rightRank = right.entryType === 'folder' ? 0 : 1;
      return leftRank - rightRank || left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
    });
}

function displayPathName(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed.split('/').filter(Boolean).pop() ?? trimmed;
}

function normalizedFolder(path: string): string {
  return path.trim().replace(/\/+$/, '');
}

function isPathInsideRoot(path: string, roots: string[]): boolean {
  return roots
    .map(normalizedFolder)
    .filter(Boolean)
    .some((root) => path === root || path.startsWith(`${root}/`));
}

function extensionFromPath(path: string): string {
  const name = displayPathName(path);
  if (!name.includes('.')) return '';
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function isImageAssetKind(kind: AssetKind | null): boolean {
  return kind === 'image' || kind === 'screenshot';
}

export function projectFileBubbleFolders(
  roots: string[],
  entries: ProjectInventoryEntry[],
  assets: ProjectAsset[],
): ProjectFileBubbleFolder[] {
  const folders = new Map<string, ProjectFileBubbleFolder>();
  const normalizedRoots = roots.map(normalizedFolder).filter(Boolean);
  for (const root of normalizedRoots) {
    if (folders.has(root)) continue;
    folders.set(root, {
      path: root,
      name: displayPathName(root),
      root,
      source: 'root',
    });
  }
  for (const entry of entries) {
    if (entry.entryType !== 'folder') continue;
    folders.set(entry.path, {
      path: entry.path,
      name: entry.name,
      root: entry.root,
      source: 'inventory',
    });
  }
  for (const asset of assets) {
    if (asset.kind !== 'folder' || !asset.path || folders.has(asset.path)) continue;
    folders.set(asset.path, {
      path: asset.path,
      name: asset.title || displayPathName(asset.path),
      root: asset.path,
      source: 'asset',
    });
  }
  if (assets.some((asset) => asset.path && !isPathInsideRoot(asset.path, normalizedRoots))) {
    folders.set(LINKED_ASSETS_FOLDER_PATH, {
      path: LINKED_ASSETS_FOLDER_PATH,
      name: 'Linked Assets',
      root: LINKED_ASSETS_FOLDER_PATH,
      source: 'linked',
    });
  }

  const sourceRank: Record<ProjectFileBubbleFolder['source'], number> = {
    root: 0,
    inventory: 1,
    asset: 2,
    linked: 3,
  };
  return [...folders.values()].sort((left, right) =>
    sourceRank[left.source] - sourceRank[right.source]
    || left.name.localeCompare(right.name)
    || left.path.localeCompare(right.path),
  );
}

export function projectFileBubbleItems(
  folderPath: string,
  entries: ProjectInventoryEntry[],
  assets: ProjectAsset[],
  roots: string[],
): ProjectFileBubbleItem[] {
  const folder = normalizedFolder(folderPath);
  const normalizedRoots = roots.map(normalizedFolder).filter(Boolean);
  const items = new Map<string, ProjectFileBubbleItem>();

  if (folder === LINKED_ASSETS_FOLDER_PATH) {
    for (const asset of assets) {
      if (!asset.path || isPathInsideRoot(asset.path, normalizedRoots)) continue;
      items.set(asset.path, {
        path: asset.path,
        name: asset.title || displayPathName(asset.path),
        category: asset.kind,
        entryType: asset.kind === 'folder' ? 'folder' : 'file',
        extension: extensionFromPath(asset.path),
        sizeBytes: null,
        assetId: asset.id,
        assetKind: asset.kind,
        content: asset.content,
        description: asset.description,
        isImage: isImageAssetKind(asset.kind),
      });
    }
  } else {
    const prefix = `${folder}/`;
    for (const entry of projectInventoryDirectChildren(entries, folder)) {
      items.set(entry.path, {
        path: entry.path,
        name: entry.name,
        category: entry.category,
        entryType: entry.entryType,
        extension: entry.extension,
        sizeBytes: entry.sizeBytes,
        assetId: null,
        assetKind: null,
        content: null,
        description: '',
        isImage: entry.category === 'image',
      });
    }

    for (const asset of assets) {
      if (!asset.path || asset.path === folder || !asset.path.startsWith(prefix)) continue;
      const relative = asset.path.slice(prefix.length);
      if (!relative || relative.includes('/')) continue;
      items.set(asset.path, {
        path: asset.path,
        name: asset.title || displayPathName(asset.path),
        category: asset.kind,
        entryType: asset.kind === 'folder' ? 'folder' : 'file',
        extension: extensionFromPath(asset.path),
        sizeBytes: null,
        assetId: asset.id,
        assetKind: asset.kind,
        content: asset.content,
        description: asset.description,
        isImage: isImageAssetKind(asset.kind),
      });
    }
  }

  return [...items.values()].sort((left, right) => {
    const leftRank = left.entryType === 'folder' ? 0 : left.isImage ? 1 : 2;
    const rightRank = right.entryType === 'folder' ? 0 : right.isImage ? 1 : 2;
    return leftRank - rightRank || left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
  });
}

export function normalizeAssetAttachment(
  value: Partial<AssetAttachment>,
): AssetAttachment | null {
  const assetId = trimString(value.assetId);
  const targetId = trimString(value.targetId);
  const targetType = value.targetType && TARGET_TYPES.includes(value.targetType) ? value.targetType : null;
  if (!assetId || !targetId || !targetType) return null;

  return {
    assetId,
    targetType,
    targetId,
    attachedAt: finiteNumber(value.attachedAt, Date.now()),
  };
}

export function normalizeAssetAttachments(
  value: Partial<AssetAttachment>[] | null | undefined,
): AssetAttachment[] {
  return (value ?? [])
    .map((attachment) => normalizeAssetAttachment(attachment))
    .filter((attachment): attachment is AssetAttachment => attachment !== null);
}

export function removeAssetAttachmentsForAsset(
  attachments: AssetAttachment[],
  assetId: string,
): AssetAttachment[] {
  const id = assetId.trim();
  if (!id) return attachments;
  return attachments.filter((attachment) => attachment.assetId !== id);
}

function createProjectAssetsStore() {
  const { subscribe, set, update } = writable<ProjectAsset[]>([]);

  return {
    subscribe,
    set(assets: Partial<ProjectAsset>[]) {
      set(normalizeProjectAssets(assets));
    },
    upsert(asset: Partial<ProjectAsset>): ProjectAsset | null {
      const normalized = normalizeProjectAsset(asset);
      if (!normalized) return null;

      update((current) => {
        const filtered = current.filter((entry) => entry.id !== normalized.id);
        return [...filtered, normalized].sort((left, right) => left.title.localeCompare(right.title));
      });
      return normalized;
    },
    remove(assetId: string): void {
      const id = assetId.trim();
      if (!id) return;
      update((current) => current.filter((asset) => asset.id !== id));
    },
    reset(): void {
      set([]);
    },
  };
}

function createProjectInventoryStore() {
  const { subscribe, set } = writable<ProjectInventoryEntry[]>([]);

  return {
    subscribe,
    set(entries: Partial<ProjectInventoryEntry>[]) {
      set(normalizeProjectInventory(entries));
    },
    reset(): void {
      set([]);
    },
  };
}

function createAssetAttachmentsStore() {
  const { subscribe, set, update } = writable<AssetAttachment[]>([]);

  return {
    subscribe,
    set(attachments: Partial<AssetAttachment>[]) {
      set(normalizeAssetAttachments(attachments));
    },
    attach(attachment: Partial<AssetAttachment>): AssetAttachment | null {
      const normalized = normalizeAssetAttachment(attachment);
      if (!normalized) return null;

      update((current) => {
        const filtered = current.filter(
          (entry) =>
            entry.assetId !== normalized.assetId ||
            entry.targetType !== normalized.targetType ||
            entry.targetId !== normalized.targetId,
        );
        return [...filtered, normalized];
      });
      return normalized;
    },
    detach(assetId: string, targetType: AssetAttachment['targetType'], targetId: string): void {
      const normalized = normalizeAssetAttachment({ assetId, targetType, targetId });
      if (!normalized) return;

      update((current) =>
        current.filter(
          (entry) =>
            entry.assetId !== normalized.assetId ||
            entry.targetType !== normalized.targetType ||
            entry.targetId !== normalized.targetId,
        ),
      );
    },
    removeForAsset(assetId: string): void {
      update((current) => removeAssetAttachmentsForAsset(current, assetId));
    },
    reset(): void {
      set([]);
    },
  };
}

function applyAssetCatalog(catalog: ProjectAssetCatalog): void {
  projectAssets.set(catalog.assets ?? []);
  assetAttachments.set(catalog.attachments ?? []);
  projectInventory.set(catalog.inventory ?? []);
}

export function projectAssetRefreshSummary(
  catalog: Pick<ProjectAssetCatalog, 'importedCount' | 'scannedRoots'>,
): string {
  const importedCount = Number.isFinite(catalog.importedCount) ? catalog.importedCount ?? 0 : 0;
  const scannedRootCount = catalog.scannedRoots?.length ?? 0;
  const rootNoun = scannedRootCount === 1 ? 'root' : 'roots';
  if (importedCount > 0) {
    const assetNoun = importedCount === 1 ? 'asset' : 'assets';
    return `Imported ${importedCount} project ${assetNoun} from ${scannedRootCount} scanned ${rootNoun}.`;
  }
  return `No new project assets found. Scanned ${scannedRootCount} ${rootNoun}.`;
}

export const projectAssets = createProjectAssetsStore();
export const projectInventory = createProjectInventoryStore();
export const assetAttachments = createAssetAttachmentsStore();

export async function loadProjectAssets(projectId: string): Promise<ProjectAssetCatalog> {
  const id = projectId.trim();
  if (!id) throw new Error('project id is required');
  const catalog = await invoke<ProjectAssetCatalog>('ui_list_project_assets', { projectId: id });
  applyAssetCatalog(catalog);
  return catalog;
}

export async function saveProjectAsset(asset: Partial<ProjectAsset>): Promise<ProjectAsset> {
  const normalized = normalizeProjectAsset({
    ...asset,
    updatedAt: Date.now(),
    createdAt: asset.createdAt ?? Date.now(),
  });
  if (!normalized) {
    throw new Error('asset id, project id, kind, and title are required');
  }

  const saved = await invoke<ProjectAsset>('ui_save_project_asset', { asset: normalized });
  const resynced = normalizeProjectAsset(saved) ?? normalized;
  projectAssets.upsert(resynced);
  return resynced;
}

export async function readAssetTextFile(path: string): Promise<string> {
  const trimmed = path.trim();
  if (!trimmed) throw new Error('asset text file path is required');
  return invoke<string>('ui_read_asset_text_file', { path: trimmed });
}

export async function refreshProjectAssets(projectId: string): Promise<ProjectAssetCatalog> {
  const id = projectId.trim();
  if (!id) throw new Error('project id is required');
  const catalog = await invoke<ProjectAssetCatalog>('ui_refresh_project_assets', { projectId: id });
  applyAssetCatalog(catalog);
  return catalog;
}

export async function analyzeProjectAsset(assetId: string): Promise<ProjectAsset> {
  const id = assetId.trim();
  if (!id) throw new Error('asset id is required');

  const analyzed = await invoke<ProjectAsset>('ui_analyze_project_asset', { assetId: id });
  const normalized = normalizeProjectAsset(analyzed);
  if (!normalized) {
    throw new Error('analyzed asset response was invalid');
  }
  projectAssets.upsert(normalized);
  return normalized;
}

export async function deleteProjectAsset(assetId: string): Promise<boolean> {
  const id = assetId.trim();
  if (!id) return false;
  const deleted = await invoke<boolean>('ui_delete_project_asset', { assetId: id });
  if (deleted) {
    projectAssets.remove(id);
    assetAttachments.removeForAsset(id);
  }
  return deleted;
}

export async function attachAsset(
  assetId: string,
  targetType: AssetAttachment['targetType'],
  targetId: string,
): Promise<AssetAttachment | null> {
  const normalized = normalizeAssetAttachment({ assetId, targetType, targetId });
  if (!normalized) return null;

  const saved = await invoke<AssetAttachment>('ui_attach_asset', {
    assetId: normalized.assetId,
    targetType: normalized.targetType,
    targetId: normalized.targetId,
  });
  const attachment = normalizeAssetAttachment(saved) ?? normalized;
  assetAttachments.attach(attachment);
  return attachment;
}

export async function detachAsset(
  assetId: string,
  targetType: AssetAttachment['targetType'],
  targetId: string,
): Promise<boolean> {
  const normalized = normalizeAssetAttachment({ assetId, targetType, targetId });
  if (!normalized) return false;

  const deleted = await invoke<boolean>('ui_detach_asset', {
    assetId: normalized.assetId,
    targetType: normalized.targetType,
    targetId: normalized.targetId,
  });
  if (deleted) {
    assetAttachments.detach(normalized.assetId, normalized.targetType, normalized.targetId);
  }
  return deleted;
}
