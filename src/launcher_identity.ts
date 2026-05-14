import { type Env, listProfileNames, loadProfileEnv } from "./profile_env";

const IDENTITY_PREFIX = "identity:";

// Canonical agent roots swarm-mcp knows how to spawn. Each profile maps these
// to its own launcher alias via SWARM_HARNESS_<UPPER>=<alias>. Profile names
// themselves are user-defined (no reserved "personal"/"work").
export const CANONICAL_HARNESSES = ["claude", "codex", "opencode", "hermes"] as const;
export type CanonicalHarness = (typeof CANONICAL_HARNESSES)[number];

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function identityNameFromToken(identity: string | null | undefined): string {
  const clean = (identity ?? "").trim();
  const name = clean.startsWith(IDENTITY_PREFIX)
    ? clean.slice(IDENTITY_PREFIX.length)
    : clean;
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : "";
}

export function identityTokenFromName(identity: string | null | undefined): string {
  const name = identityNameFromToken(identity);
  return name ? `${IDENTITY_PREFIX}${name}` : "";
}

export function profileEnvSuffix(identity: string | null | undefined): string {
  const name = identityNameFromToken(identity);
  return name ? name.toUpperCase().replace(/[^A-Z0-9_]/g, "_") : "";
}

export function profileScopedEnvName(
  identity: string | null | undefined,
  suffix: string,
): string {
  const profile = profileEnvSuffix(identity);
  return profile ? `SWARM_MCP_${profile}_${suffix}` : "";
}

export function identityFromEnv(env: Env = process.env): string {
  return identityNameFromToken(
    stringValue(env.AGENT_IDENTITY) ||
      stringValue(env.SWARM_IDENTITY) ||
      stringValue(env.SWARM_CC_IDENTITY) ||
      stringValue(env.SWARM_CODEX_IDENTITY) ||
      stringValue(env.SWARM_HERMES_IDENTITY),
  );
}

// Resolve the env an identity sees: overlay the target profile's env file
// under the current env so process-level overrides win, but the profile's
// harness aliases and socket path fill in any gaps the launcher didn't export.
function resolveIdentityEnv(identity: string, env: Env): Env {
  if (!identity) return env;
  const profileEnv = loadProfileEnv(identity, env);
  if (identityFromEnv(env) === identity) return { ...profileEnv, ...env };
  return { ...env, ...profileEnv };
}

function aliasLookup(env: Env, lower: string): CanonicalHarness | "" {
  for (const canon of CANONICAL_HARNESSES) {
    const alias = stringValue(env[`SWARM_HARNESS_${canon.toUpperCase()}`]).toLowerCase();
    if (alias && alias === lower) return canon;
  }
  return "";
}

export function canonicalizeHarness(harness: string, env: Env = process.env): CanonicalHarness | "" {
  const lower = harness.trim().toLowerCase();
  if (!lower) return "";
  if ((CANONICAL_HARNESSES as readonly string[]).includes(lower)) {
    return lower as CanonicalHarness;
  }
  const fromCurrent = aliasLookup(env, lower);
  if (fromCurrent) return fromCurrent;
  // Cross-profile normalization: a personal worker getting a work-aliased
  // request (or vice versa) still needs to map the alias to its canonical
  // harness so the caller's identity-specific launcher can be picked.
  for (const profile of listProfileNames(env)) {
    const fromProfile = aliasLookup(loadProfileEnv(profile, env), lower);
    if (fromProfile) return fromProfile;
  }
  return "";
}

// Resolve the launcher alias to exec for a given canonical harness under a
// given identity. If the harness is not canonical and not a known alias, pass
// it through unchanged (treats it as an opaque binary name the caller wants).
export function launcherForIdentity(
  harness: string,
  identity: string | null | undefined,
  env: Env = process.env,
): string {
  const clean = harness.trim();
  if (!clean) return "";
  const name = identityNameFromToken(identity);
  if (!name) return clean;
  const identityEnv = resolveIdentityEnv(name, env);
  const canonical = canonicalizeHarness(clean, identityEnv);
  if (!canonical) return clean;
  const alias = stringValue(identityEnv[`SWARM_HARNESS_${canonical.toUpperCase()}`]);
  return alias || canonical;
}

export function labelWithIdentity(
  label: string | null | undefined,
  identity: string | null | undefined,
): string {
  const token = identityTokenFromName(identity);
  const parts = (label ?? "").trim().split(/\s+/).filter(Boolean);
  if (!token) return parts.join(" ");

  const identities = parts.filter((part) => part.startsWith(IDENTITY_PREFIX));
  const conflicting = identities.find((part) => part !== token);
  if (conflicting) {
    throw new Error(
      `Spawn label identity ${conflicting} does not match requester ${token}`,
    );
  }

  return [token, ...parts.filter((part) => !part.startsWith(IDENTITY_PREFIX))]
    .filter(Boolean)
    .join(" ");
}
