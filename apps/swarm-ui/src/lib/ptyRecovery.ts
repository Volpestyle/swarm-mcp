import type { BindingState, Instance, PtySession } from './types';

const HARNESS_COMMANDS = new Set(['claude', 'codex', 'opencode']);

export function harnessFromCommand(command: string | null | undefined): string | null {
  const normalized = command?.trim().toLowerCase() ?? '';
  return HARNESS_COMMANDS.has(normalized) ? normalized : null;
}

export function ptyMatchesScope(pty: PtySession, activeScope: string | null): boolean {
  if (activeScope === null) return true;
  const scope = trimTrailingSlash(activeScope);
  const cwd = trimTrailingSlash(pty.cwd);
  return cwd === scope || cwd.startsWith(`${scope}/`);
}

export function isOrphanAgentPty(
  pty: PtySession,
  instanceMap: Map<string, Instance>,
  bindingState: BindingState,
): boolean {
  if (!harnessFromCommand(pty.command)) return false;
  if (pty.launch_token) return false;
  const resolvedInstanceId = bindingState.resolved.find(([, ptyId]) => ptyId === pty.id)?.[0] ?? null;
  if (resolvedInstanceId && instanceMap.has(resolvedInstanceId)) return false;
  if (pty.bound_instance_id && instanceMap.has(pty.bound_instance_id)) return false;
  return true;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/';
}
