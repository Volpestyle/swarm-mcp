import { invoke } from '@tauri-apps/api/core';

export type LaunchCommandTrustPosture = 'standard' | 'full-access';

export interface LaunchCommandPreflight {
  ok: boolean;
  command: string;
  executable: string;
  resolvedPath: string | null;
  shell: string;
  pathPreview: string;
  diagnostics: string[];
  warnings: string[];
  blocker: string | null;
  trustPosture: LaunchCommandTrustPosture;
  native: boolean;
}

export interface LaunchCommandPreflightInput {
  command?: string | null;
  cwd?: string | null;
  harness?: string | null;
  commandSource?: string | null;
}

interface ShellWordResult {
  words: string[];
  error: string | null;
}

const FULL_ACCESS_PATTERN = /\b(flux9?|dangerously|bypass|skip[-\s]*permissions?|full[-\s]*access|danger-full-access|no[-\s]*sandbox)\b/i;

function trim(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function basename(value: string): string {
  const parts = value.split('/');
  return parts[parts.length - 1] || value;
}

export function shellWords(command: string, limit = 12): ShellWordResult {
  const source = command.trim();
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
        if (words.length >= limit) break;
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += '\\';
  }

  if (quote) {
    return {
      words,
      error: `Command has an unterminated ${quote === '"' ? 'double' : 'single'} quote.`,
    };
  }

  if (current && words.length < limit) {
    words.push(current);
  }

  return { words, error: null };
}

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isEnvFlag(word: string): boolean {
  return word === '-' || word === '-i' || word === '-0' || word === '--ignore-environment';
}

export function extractLaunchExecutable(command: string): { executable: string; error: string | null } {
  const parsed = shellWords(command);
  if (parsed.error) {
    return { executable: '', error: parsed.error };
  }

  let index = 0;
  while (index < parsed.words.length) {
    const word = parsed.words[index];

    if (isEnvAssignment(word)) {
      index += 1;
      continue;
    }

    if (word === 'exec' || word === 'command' || word === 'noglob') {
      index += 1;
      continue;
    }

    if (word === 'env') {
      index += 1;
      while (index < parsed.words.length) {
        const candidate = parsed.words[index];
        if (isEnvFlag(candidate) || isEnvAssignment(candidate)) {
          index += 1;
          continue;
        }
        if (candidate === '-u' || candidate === '--unset') {
          index += 2;
          continue;
        }
        break;
      }
      continue;
    }

    return { executable: word, error: null };
  }

  return { executable: '', error: 'Command does not include an executable.' };
}

export function inferCommandTrustPosture(command: string): LaunchCommandTrustPosture {
  return FULL_ACCESS_PATTERN.test(command) ? 'full-access' : 'standard';
}

function providerForExecutable(executable: string): string {
  const normalized = basename(executable).toLowerCase();
  if (!normalized) return '';
  if (normalized === 'flux') return 'claude';
  if (normalized === 'flux9') return 'codex';
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('opencode')) return 'opencode';
  return '';
}

export function commandProviderWarning(
  command: string,
  harness: string | null | undefined,
): string {
  const normalizedHarness = trim(harness).toLowerCase();
  if (!normalizedHarness) return '';

  const executable = extractLaunchExecutable(command).executable;
  const provider = providerForExecutable(executable);
  if (!provider || provider === normalizedHarness) return '';

  return `Command/provider mismatch: ${executable} looks like ${provider}, but this launch is configured as ${normalizedHarness}.`;
}

function normalizePreflight(
  raw: Partial<LaunchCommandPreflight>,
  input: LaunchCommandPreflightInput,
): LaunchCommandPreflight {
  const command = trim(raw.command) || trim(input.command) || trim(input.harness);
  const executable = trim(raw.executable) || extractLaunchExecutable(command).executable;
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean) : [];
  const mismatch = commandProviderWarning(command, input.harness);
  if (mismatch && !warnings.includes(mismatch)) {
    warnings.push(mismatch);
  }

  return {
    ok: Boolean(raw.ok),
    command,
    executable,
    resolvedPath: trim(raw.resolvedPath) || null,
    shell: trim(raw.shell) || 'login shell',
    pathPreview: trim(raw.pathPreview),
    diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics.filter(Boolean) : [],
    warnings,
    blocker: trim(raw.blocker) || null,
    trustPosture: raw.trustPosture === 'full-access'
      ? 'full-access'
      : inferCommandTrustPosture(command),
    native: raw.native ?? true,
  };
}

export function fallbackLaunchCommandPreflight(
  input: LaunchCommandPreflightInput,
  reason?: unknown,
): LaunchCommandPreflight {
  const command = trim(input.command) || trim(input.harness);
  const executableResult = extractLaunchExecutable(command);
  const diagnostics = reason
    ? [`Native launch preflight unavailable: ${reason instanceof Error ? reason.message : String(reason)}`]
    : [];
  const warnings: string[] = [];
  const mismatch = commandProviderWarning(command, input.harness);
  if (mismatch) warnings.push(mismatch);

  if (!command) {
    return {
      ok: false,
      command,
      executable: '',
      resolvedPath: null,
      shell: 'browser fallback',
      pathPreview: '',
      diagnostics,
      warnings,
      blocker: 'Launch command is empty.',
      trustPosture: 'standard',
      native: false,
    };
  }

  if (executableResult.error) {
    return {
      ok: false,
      command,
      executable: executableResult.executable,
      resolvedPath: null,
      shell: 'browser fallback',
      pathPreview: '',
      diagnostics,
      warnings,
      blocker: executableResult.error,
      trustPosture: inferCommandTrustPosture(command),
      native: false,
    };
  }

  return {
    ok: true,
    command,
    executable: executableResult.executable,
    resolvedPath: null,
    shell: 'browser fallback',
    pathPreview: '',
    diagnostics,
    warnings,
    blocker: null,
    trustPosture: inferCommandTrustPosture(command),
    native: false,
  };
}

export async function preflightLaunchCommand(
  input: LaunchCommandPreflightInput,
): Promise<LaunchCommandPreflight> {
  const command = trim(input.command) || trim(input.harness);
  if (!command) {
    return fallbackLaunchCommandPreflight(input);
  }

  try {
    const native = await invoke<LaunchCommandPreflight>('ui_preflight_launch_command', {
      command,
      cwd: trim(input.cwd) || null,
    });
    return normalizePreflight(native, { ...input, command });
  } catch (err) {
    return fallbackLaunchCommandPreflight({ ...input, command }, err);
  }
}

export function formatLaunchPreflightFailure(preflight: LaunchCommandPreflight): string {
  const blocker = preflight.blocker || 'Launch command preflight failed.';
  const diagnostic = preflight.diagnostics[0] ? ` ${preflight.diagnostics[0]}` : '';
  return `${blocker}${diagnostic}`;
}

export function summarizeLaunchCommandPreflight(preflight: LaunchCommandPreflight): string {
  const executable = preflight.executable || preflight.command || 'command';
  if (!preflight.native) {
    return `Parsed ${executable}; native PATH check will run in the app shell.`;
  }
  if (preflight.resolvedPath) {
    return `${preflight.shell} resolved ${executable} as ${preflight.resolvedPath}.`;
  }
  return `${preflight.shell} accepted ${executable}.`;
}
