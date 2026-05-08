import type { OpenDialogOptions } from '@tauri-apps/plugin-dialog';
import type { AssetKind, ProjectAsset } from './types';

type AssetDraft = Pick<ProjectAsset, 'kind' | 'title' | 'path' | 'content' | 'description'>;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'];
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'rtf'];

export function firstDialogSelection(selection: string | string[] | null): string | null {
  if (Array.isArray(selection)) return selection[0]?.trim() || null;
  return selection?.trim() || null;
}

export function assetDraftFromPickedPath(path: string, kind: AssetKind): AssetDraft | null {
  const pickedPath = path.trim();
  if (!pickedPath) return null;

  const extension = extensionFromPath(pickedPath);
  if ((kind === 'image' || kind === 'screenshot') && !IMAGE_EXTENSIONS.includes(extension)) {
    return null;
  }
  if ((kind === 'note' || kind === 'protocol') && !TEXT_EXTENSIONS.includes(extension)) {
    return null;
  }

  return {
    kind,
    title: titleFromPath(pickedPath),
    path: pickedPath,
    content: null,
    description: '',
  };
}

export function assetDialogOptionsForKind(kind: AssetKind): OpenDialogOptions {
  if (kind === 'folder') {
    return {
      directory: true,
      multiple: false,
      recursive: true,
      canCreateDirectories: true,
    };
  }

  if (kind === 'image' || kind === 'screenshot') {
    return {
      multiple: false,
      directory: false,
      filters: [
        {
          name: kind === 'screenshot' ? 'Screenshot' : 'Image',
          extensions: IMAGE_EXTENSIONS,
        },
      ],
    };
  }

  if (kind === 'note' || kind === 'protocol') {
    return {
      multiple: false,
      directory: false,
      filters: [
        {
          name: kind === 'protocol' ? 'Protocol or note' : 'Note',
          extensions: TEXT_EXTENSIONS,
        },
      ],
    };
  }

  return {
    multiple: false,
    directory: false,
  };
}

function titleFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const leaf = parts.length > 0 ? parts[parts.length - 1] : path;
  const lastDot = leaf.lastIndexOf('.');
  if (lastDot > 0) {
    return leaf.slice(0, lastDot);
  }
  return leaf;
}

function extensionFromPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const leaf = parts.length > 0 ? parts[parts.length - 1] : '';
  const lastDot = leaf.lastIndexOf('.');
  return lastDot >= 0 ? leaf.slice(lastDot + 1).toLowerCase() : '';
}
