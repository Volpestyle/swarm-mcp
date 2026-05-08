import chromeLogoUrl from '../assets/app-icons/chrome-logo.png';
import darkFolderUrl from '../assets/dark-folder.png';
import notesLogoUrl from '../assets/app-icons/apple-notes-icon.png';
import obsidianLogoUrl from '../assets/app-icons/obsidian-logo.png';

export type AgentSurfaceIconKind = 'chrome' | 'obsidian' | 'notes' | 'project-folder';

export interface AgentSurfaceIcon {
  kind: AgentSurfaceIconKind;
  label: string;
  src: string;
}

export interface AgentSurfaceIconInput {
  appId?: string | null;
  source?: string | null;
  path?: string | null;
  operation?: string | null;
}

const TEXT_NOTE_EXTENSIONS = new Set(['.md', '.txt', '.rtf', '.doc', '.docx']);

const PROJECT_FOLDER_ICON: AgentSurfaceIcon = {
  kind: 'project-folder',
  label: 'Project scan',
  src: darkFolderUrl,
};

const NOTE_ICON: AgentSurfaceIcon = {
  kind: 'notes',
  label: 'Notes file',
  src: notesLogoUrl,
};

const OBSIDIAN_ICON: AgentSurfaceIcon = {
  kind: 'obsidian',
  label: 'Obsidian',
  src: obsidianLogoUrl,
};

const CHROME_ICON: AgentSurfaceIcon = {
  kind: 'chrome',
  label: 'Chrome',
  src: chromeLogoUrl,
};

export function resolveAgentSurfaceIcon(input: AgentSurfaceIconInput): AgentSurfaceIcon {
  const appId = clean(input.appId).toLowerCase();
  const source = clean(input.source).toLowerCase();
  const path = clean(input.path);
  const operation = clean(input.operation).toLowerCase();
  const haystack = `${appId} ${source} ${path}`.toLowerCase();

  if (appId === 'chrome' || source === 'browser' || source === 'chrome' || /^https?:\/\//i.test(path)) {
    return CHROME_ICON;
  }

  if (appId === 'obsidian' || source === 'obsidian' || haystack.includes('/.obsidian') || haystack.includes('obsidian://')) {
    return OBSIDIAN_ICON;
  }

  if (TEXT_NOTE_EXTENSIONS.has(fileExtension(path)) && !haystack.includes('/.obsidian')) {
    return NOTE_ICON;
  }

  if (
    operation.includes('grep') ||
    operation.includes('search') ||
    operation.includes('scan') ||
    operation.includes('read') ||
    operation.includes('project') ||
    path
  ) {
    return PROJECT_FOLDER_ICON;
  }

  return PROJECT_FOLDER_ICON;
}

export function projectFolderSurfaceIcon(): AgentSurfaceIcon {
  return PROJECT_FOLDER_ICON;
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function fileExtension(path: string): string {
  const match = path.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? '';
}
