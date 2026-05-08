import { describe, expect, it } from 'bun:test';
import {
  buildHarnessLabel,
  withCodexMcpEnv,
} from './codexLaunchCommand';

describe('codexLaunchCommand', () => {
  it('builds stable deduped swarm label tokens', () => {
    expect(
      buildHarnessLabel({
        harness: 'codex',
        role: 'planner',
        name: 'Orchestrator_Codex',
        label: 'provider:codex team:frontend',
      }),
    ).toBe('name:Orchestrator_Codex role:planner provider:codex team:frontend');
  });

  it('adds dynamic MCP env config to codex launch commands', () => {
    const command = withCodexMcpEnv('codex --dangerously-bypass-approvals-and-sandbox', {
      instanceId: 'inst-123',
      directory: '/Users/mathewfrazier/Desktop',
      fileRoot: '/Users/mathewfrazier/Desktop',
      scope: '/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul',
      label: 'name:Orchestrator_Codex role:planner provider:codex team:frontend',
      initialPrompt: 'Use the swarm register tool.',
    });

    expect(command).toStartWith('codex --dangerously-bypass-approvals-and-sandbox -c ');
    expect(command).toContain('mcp_servers.swarm.env={');
    expect(command).toContain('SWARM_MCP_INSTANCE_ID="inst-123"');
    expect(command).toContain('SWARM_MCP_SCOPE="/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul"');
    expect(command).toContain('SWARM_MCP_LABEL="name:Orchestrator_Codex role:planner provider:codex team:frontend"');
    expect(command).toEndWith("'Use the swarm register tool.'");
  });

  it('can pin the swarm MCP server command instead of relying on global Codex config', () => {
    const command = withCodexMcpEnv('flux9', {
      instanceId: 'inst-123',
      directory: '/Users/mathewfrazier/Desktop',
      fileRoot: '/Users/mathewfrazier/Desktop',
      scope: '/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul',
      label: 'name:Orchestrator_Codex role:planner provider:codex team:frontend',
      mcpCommand: 'node',
      mcpArgs: ['/Users/mathewfrazier/Desktop/swarm-mcp-lab/dist/index.js'],
      startupMode: 'standby',
      initialPrompt: 'Use the swarm register tool.',
    });

    expect(command).toContain('-c \'mcp_servers.swarm.command="node"\'');
    expect(command).toContain('-c \'mcp_servers.swarm.args=["/Users/mathewfrazier/Desktop/swarm-mcp-lab/dist/index.js"]\'');
    expect(command).toContain('-c \'mcp_servers.swarm.env={');
    expect(command).toContain('SWARM_MCP_STARTUP_MODE="standby"');
  });

  it('keeps long env values intact and appends the bootstrap prompt as one codex argument', () => {
    const command = withCodexMcpEnv('flux9', {
      instanceId: 'a53bfd24-f171-4e69-a984-8d074c087f61',
      directory: '/Users/mathewfrazier/Desktop',
      fileRoot: '/Users/mathewfrazier/Desktop',
      scope: '/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul',
      label: 'name:Orchestrator_Codex role:planner provider:codex team:frontend',
      initialPrompt:
        'Use the swarm register tool with directory="/Users/mathewfrazier/Desktop" and scope="/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul".',
    });

    expect(command).toContain('SWARM_MCP_INSTANCE_ID="a53bfd24-f171-4e69-a984-8d074c087f61"');
    expect(command).toContain('SWARM_MCP_FILE_ROOT="/Users/mathewfrazier/Desktop"');
    expect(command).toContain('SWARM_MCP_SCOPE="/Users/mathewfrazier/Desktop/swarm-mcp-lab#overhaul"');
    expect(command).toContain('provider:codex');
    expect(command).not.toContain('8d0 74');
    expect(command).not.toContain('swarm-m cp-lab');
    expect(command).not.toContain('cod ex');
  });
});
