import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export const PERSONAL_HERDR_SOCKET_PARTS = [".herdr", "personal", "herdr.sock"];
export const WORK_HERDR_SOCKET_PARTS = [".herdr", "work", "herdr.sock"];

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function identityName(value: string) {
  const clean = value.trim().toLowerCase();
  return clean.startsWith("identity:") ? clean.slice("identity:".length) : clean;
}

export function identityFromEnv(env: Env = process.env) {
  return identityName(
    stringValue(env.AGENT_IDENTITY) ||
      stringValue(env.SWARM_IDENTITY) ||
      stringValue(env.SWARM_CC_IDENTITY) ||
      stringValue(env.SWARM_CODEX_IDENTITY) ||
      stringValue(env.SWARM_HERMES_IDENTITY),
  );
}

function hostHome(env: Env) {
  return (
    stringValue(env.HERMES_HOST_HOME) ||
    stringValue(env.SWARM_HOST_HOME) ||
    stringValue(env.HOME) ||
    homedir()
  );
}

function expandHome(path: string, env: Env) {
  if (path === "~") return resolve(hostHome(env));
  if (path.startsWith("~/")) return resolve(hostHome(env), path.slice(2));
  return resolve(path);
}

export function personalControlRoot(env: Env = process.env) {
  const configured = stringValue(env.SWARM_MCP_PERSONAL_ROOTS);
  if (configured) {
    const firstRoot = configured
      .split(delimiter)
      .map((item) => item.trim())
      .find(Boolean);
    if (firstRoot) return expandHome(firstRoot, env);
  }
  return resolve(hostHome(env), "volpestyle");
}

export function preferredPersonalHerdrSocketPath(env: Env = process.env) {
  return resolve(personalControlRoot(env), ...PERSONAL_HERDR_SOCKET_PARTS);
}

export function preferredWorkHerdrSocketPath(env: Env = process.env) {
  return resolve(hostHome(env), ...WORK_HERDR_SOCKET_PARTS);
}

export function resolvedHerdrSocketPath(env: Env = process.env) {
  const explicit = stringValue(env.HERDR_SOCKET_PATH);
  if (explicit) return explicit;
  const identity = identityFromEnv(env);
  if (identity === "personal") return preferredPersonalHerdrSocketPath(env);
  if (identity === "work") return preferredWorkHerdrSocketPath(env);
  return "";
}

export function herdrEnvWithSocket(env: Env = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const socketPath = resolvedHerdrSocketPath(env);
  if (socketPath) next.HERDR_SOCKET_PATH = socketPath;
  return next;
}
