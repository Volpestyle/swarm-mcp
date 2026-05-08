export type BuildProvenance = {
  appVersion: string;
  buildProfile: string;
  runKind: string;
  gitBranch: string;
  gitCommit: string;
  gitDirty: boolean;
  buildUnix?: number | null;
  executableModifiedUnix?: number | null;
  executablePath: string;
  appBundlePath?: string | null;
  currentWorkingDirectory: string;
  sourceRoot: string;
  manifestDir: string;
};

export type AppVariant = 'lab' | 'active' | 'local' | 'unknown';
export type DockStatus = 'not-this-run' | 'this-bundle-run' | 'unknown';

export type AppIdentity = {
  appName: 'swarm-ui';
  appVariant: AppVariant;
  appVersion: string;
  shell: 'tauri';
  tauriMajor: 2;
  runKind: string;
  buildProfile: string;
  sourceRoot: string;
  currentWorkingDirectory: string;
  executablePath: string;
  appBundlePath: string | null;
  gitBranch: string;
  gitCommit: string;
  gitDirty: boolean;
  buildUnix: number | null;
  executableModifiedUnix: number | null;
  dockStatus: DockStatus;
};

export function appVariantFromProvenance(provenance: BuildProvenance): AppVariant {
  const source = provenance.sourceRoot.toLowerCase();
  const runPath = `${provenance.appBundlePath ?? ''} ${provenance.executablePath}`.toLowerCase();
  if (source.includes('swarm-mcp-lab') || runPath.includes('swarm ui lab')) return 'lab';
  if (source.includes('swarm-mcp-active') || runPath.includes('swarm ui active')) return 'active';
  if (source || runPath) return 'local';
  return 'unknown';
}

export function dockStatusFromProvenance(provenance: BuildProvenance): DockStatus {
  if (provenance.runKind === 'app-bundle') return 'this-bundle-run';
  if (provenance.runKind === 'tauri-dev') return 'not-this-run';
  return 'unknown';
}

export function appIdentityFromProvenance(provenance: BuildProvenance): AppIdentity {
  return {
    appName: 'swarm-ui',
    appVariant: appVariantFromProvenance(provenance),
    appVersion: provenance.appVersion,
    shell: 'tauri',
    tauriMajor: 2,
    runKind: provenance.runKind,
    buildProfile: provenance.buildProfile,
    sourceRoot: provenance.sourceRoot,
    currentWorkingDirectory: provenance.currentWorkingDirectory,
    executablePath: provenance.executablePath,
    appBundlePath: provenance.appBundlePath ?? null,
    gitBranch: provenance.gitBranch,
    gitCommit: provenance.gitCommit,
    gitDirty: provenance.gitDirty,
    buildUnix: provenance.buildUnix ?? null,
    executableModifiedUnix: provenance.executableModifiedUnix ?? null,
    dockStatus: dockStatusFromProvenance(provenance),
  };
}

export function browserPreviewIdentity(appVersion: string, sourceRoot = ''): AppIdentity {
  return {
    appName: 'swarm-ui',
    appVariant: sourceRoot.includes('swarm-mcp-lab') ? 'lab' : 'local',
    appVersion,
    shell: 'tauri',
    tauriMajor: 2,
    runKind: 'browser-preview',
    buildProfile: 'preview',
    sourceRoot,
    currentWorkingDirectory: sourceRoot,
    executablePath: 'Vite/browser preview',
    appBundlePath: null,
    gitBranch: 'unknown',
    gitCommit: 'unknown',
    gitDirty: false,
    buildUnix: null,
    executableModifiedUnix: null,
    dockStatus: 'unknown',
  };
}

export function compactRunPath(identity: AppIdentity): string {
  const path = identity.appBundlePath || identity.executablePath;
  return path
    .replace('/Users/mathewfrazier/Desktop/', '~/Desktop/')
    .replace('/Users/mathewfrazier/', '~/');
}

export function runKindLabel(runKind: string): string {
  if (runKind === 'browser-preview') return 'PREVIEW';
  if (runKind === 'app-bundle') return 'BUNDLE';
  if (runKind === 'tauri-dev') return 'DEV';
  if (runKind === 'release-binary') return 'RELEASE';
  return 'DEBUG';
}
