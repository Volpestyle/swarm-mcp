import { identityFromEnv } from "./launcher_identity";
import { type Env, loadProfileEnv } from "./profile_env";

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export { identityFromEnv };

export function resolvedHerdrSocketPath(env: Env = process.env): string {
  const explicit = stringValue(env.HERDR_SOCKET_PATH);
  if (explicit) return explicit;
  const identity = identityFromEnv(env);
  if (!identity) return "";
  return stringValue(loadProfileEnv(identity, env).HERDR_SOCKET_PATH);
}

export function herdrEnvWithSocket(env: Env = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const socketPath = resolvedHerdrSocketPath(env);
  if (socketPath) next.HERDR_SOCKET_PATH = socketPath;
  return next;
}
