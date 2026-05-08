import { describe, expect, test } from 'bun:test';
import {
  appIdentityFromProvenance,
  appVariantFromProvenance,
  browserPreviewIdentity,
  compactRunPath,
  dockStatusFromProvenance,
  runKindLabel,
  type BuildProvenance,
} from './appIdentity';

const base: BuildProvenance = {
  appVersion: '0.1.0',
  buildProfile: 'debug',
  runKind: 'tauri-dev',
  gitBranch: 'main',
  gitCommit: 'abcdef123456',
  gitDirty: true,
  buildUnix: 1710000000,
  executableModifiedUnix: 1710000100,
  executablePath: '/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src-tauri/target/debug/swarm-ui',
  appBundlePath: null,
  currentWorkingDirectory: '/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui',
  sourceRoot: '/Users/mathewfrazier/Desktop/swarm-mcp-lab',
  manifestDir: '/Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/src-tauri',
};

describe('app identity', () => {
  test('detects lab dev runs and dock status', () => {
    expect(appVariantFromProvenance(base)).toBe('lab');
    expect(dockStatusFromProvenance(base)).toBe('not-this-run');
    const identity = appIdentityFromProvenance(base);
    expect(identity.appVariant).toBe('lab');
    expect(identity.appVersion).toBe('0.1.0');
    expect(identity.tauriMajor).toBe(2);
    expect(runKindLabel(identity.runKind)).toBe('DEV');
  });

  test('detects active source roots', () => {
    const identity = appIdentityFromProvenance({
      ...base,
      sourceRoot: '/Users/mathewfrazier/Desktop/swarm-mcp-active',
    });
    expect(identity.appVariant).toBe('active');
  });

  test('detects app bundle runs', () => {
    const identity = appIdentityFromProvenance({
      ...base,
      runKind: 'app-bundle',
      appBundlePath: '/Users/mathewfrazier/Applications/Swarm UI Lab.app',
      executablePath: '/Users/mathewfrazier/Applications/Swarm UI Lab.app/Contents/MacOS/swarm-ui',
    });
    expect(identity.dockStatus).toBe('this-bundle-run');
    expect(compactRunPath(identity)).toBe('~/Applications/Swarm UI Lab.app');
  });

  test('provides browser preview identity for visual atlas fallback', () => {
    const identity = browserPreviewIdentity('0.1.0', '/Users/mathewfrazier/Desktop/swarm-mcp-lab');
    expect(identity.appVariant).toBe('lab');
    expect(identity.runKind).toBe('browser-preview');
    expect(runKindLabel(identity.runKind)).toBe('PREVIEW');
    expect(compactRunPath(identity)).toBe('Vite/browser preview');
  });
});
