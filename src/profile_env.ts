import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type Env = Record<string, string | undefined>;

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function hostHome(env: Env): string {
  return (
    stringValue(env.HERMES_HOST_HOME) ||
    stringValue(env.SWARM_HOST_HOME) ||
    stringValue(env.HOME) ||
    homedir()
  );
}

function expandHome(path: string, env: Env): string {
  if (path === "~") return resolve(hostHome(env));
  if (path.startsWith("~/")) return resolve(hostHome(env), path.slice(2));
  return resolve(path);
}

export function profileConfigDir(env: Env = process.env): string {
  const explicit = stringValue(env.SWARM_MCP_PROFILE_DIR);
  if (explicit) return expandHome(explicit, env);
  const xdg = stringValue(env.XDG_CONFIG_HOME);
  const base = xdg ? expandHome(xdg, env) : resolve(hostHome(env), ".config");
  return resolve(base, "swarm-mcp");
}

const QUOTED = /^(['"])(.*)\1$/;
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function expandEnvValue(value: string, env: Env): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g, (_match, key: string, fallback: string) => {
      return stringValue(env[key]) || fallback;
    })
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => stringValue(env[key]))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => stringValue(env[key]));
}

function parseEnvFile(content: string, env: Env): Env {
  const out: Env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!VALID_KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = QUOTED.exec(value);
    if (quoted) value = quoted[2];
    value = expandEnvValue(value, { ...env, ...out });
    out[key] = value;
  }
  return out;
}

export function profileEnvPath(profile: string, env: Env = process.env): string {
  return resolve(profileConfigDir(env), `${profile}.env`);
}

export function loadProfileEnv(profile: string, env: Env = process.env): Env {
  if (!profile.trim()) return {};
  try {
    return parseEnvFile(readFileSync(profileEnvPath(profile, env), "utf8"), env);
  } catch {
    return {};
  }
}

export function listProfileNames(env: Env = process.env): string[] {
  try {
    return readdirSync(profileConfigDir(env))
      .filter((name) => name.endsWith(".env"))
      .map((name) => name.slice(0, -".env".length));
  } catch {
    return [];
  }
}
