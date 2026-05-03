export interface HarnessLabelInput {
  harness: string | null;
  role?: string | null;
  name?: string | null;
  label?: string | null;
}

export interface CodexMcpEnvInput {
  instanceId?: string | null;
  directory: string;
  fileRoot?: string | null;
  scope?: string | null;
  label?: string | null;
  initialPrompt?: string | null;
  mcpCommand?: string | null;
  mcpArgs?: string[];
  startupMode?: 'standby' | 'autonomous' | null;
}

const CODEX_MCP_COMMAND_KEY = 'mcp_servers.swarm.command=';
const CODEX_MCP_ARGS_KEY = 'mcp_servers.swarm.args=';
const CODEX_MCP_ENV_PREFIX = 'mcp_servers.swarm.env=';

export function buildHarnessLabel(input: HarnessLabelInput): string {
  const tokens: string[] = [];
  const seen = new Set<string>();

  const pushTokens = (value?: string | null) => {
    for (const token of value?.trim().split(/\s+/) ?? []) {
      if (token && !seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
  };

  if (input.name?.trim()) {
    pushTokens(`name:${input.name.trim()}`);
  }
  if (input.role?.trim()) {
    pushTokens(`role:${input.role.trim()}`);
  }
  if (input.harness?.trim() && input.harness.trim() !== 'shell') {
    pushTokens(`provider:${input.harness.trim()}`);
  }
  pushTokens(input.label);

  return tokens.join(' ');
}

export function withCodexMcpEnv(command: string, input: CodexMcpEnvInput): string {
  const trimmedCommand = command.trim();
  const instanceId = input.instanceId?.trim();
  if (!trimmedCommand || !instanceId) {
    return trimmedCommand;
  }

  const entries: [string, string][] = [
    ['SWARM_MCP_INSTANCE_ID', instanceId],
    ['SWARM_MCP_DIRECTORY', input.directory],
    ['SWARM_MCP_FILE_ROOT', input.fileRoot?.trim() || input.directory],
  ];
  if (input.startupMode?.trim()) {
    entries.push(['SWARM_MCP_STARTUP_MODE', input.startupMode.trim()]);
  }

  if (input.scope?.trim()) {
    entries.push(['SWARM_MCP_SCOPE', input.scope.trim()]);
  }
  if (input.label?.trim()) {
    entries.push(['SWARM_MCP_LABEL', input.label.trim()]);
  }

  const inlineTable = `{${entries
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(',')}}`;
  const configs: string[] = [];
  if (input.mcpCommand?.trim()) {
    configs.push(`${CODEX_MCP_COMMAND_KEY}${tomlString(input.mcpCommand.trim())}`);
    configs.push(`${CODEX_MCP_ARGS_KEY}${tomlArray(input.mcpArgs ?? [])}`);
  }
  configs.push(`${CODEX_MCP_ENV_PREFIX}${inlineTable}`);
  const configuredCommand = [
    trimmedCommand,
    ...configs.map((config) => `-c ${shellQuote(config)}`),
  ].join(' ');
  const initialPrompt = input.initialPrompt?.trim();

  return initialPrompt
    ? `${configuredCommand} ${shellQuote(initialPrompt)}`
    : configuredCommand;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(',')}]`;
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}
