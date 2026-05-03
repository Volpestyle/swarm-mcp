import type { ProjectAsset } from './types';

export function buildAssetContextBlock(assets: ProjectAsset[]): string {
  if (assets.length === 0) return '';

  const lines = ['Project assets:'];
  for (const asset of assets) {
    const location = asset.path ? ` (${asset.path})` : '';
    const description = asset.description ? ` - ${asset.description}` : '';
    lines.push(`- [${asset.kind}] ${asset.title}${location}${description}`);
    if (asset.content) {
      const label = asset.kind === 'image' || asset.kind === 'screenshot'
        ? 'Visual analysis'
        : 'Notes';
      lines.push(`  ${label}: ${asset.content}`);
    }
  }
  return lines.join('\n');
}

export function buildAssetDirectMessage(projectName: string, assets: ProjectAsset[]): string {
  const block = buildAssetContextBlock(assets);
  if (!block) return '';

  return [
    `[asset-context] ${projectName.trim() || 'Project'}`,
    block,
    'Use these assets as project context only. Do not change cwd, channel, or filesystem assumptions because an asset was attached. Inspect the asset paths/content, then continue normal swarm behavior: poll messages/tasks and use wait_for_activity when idle.',
  ].join('\n');
}
