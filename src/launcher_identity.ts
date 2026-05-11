const IDENTITY_PREFIX = "identity:";

const PERSONAL_LAUNCHERS: Record<string, string> = {
  claude: "clowd",
  clawd: "clowd",
  clowd: "clowd",
  codex: "cdx",
  cdx: "cdx",
  opencode: "opc",
  opc: "opc",
  hermes: "hermesp",
  hermesw: "hermesp",
  hermesp: "hermesp",
};

const WORK_LAUNCHERS: Record<string, string> = {
  claude: "clawd",
  clawd: "clawd",
  clowd: "clawd",
  codex: "codex",
  cdx: "codex",
  opencode: "opencode",
  opc: "opencode",
  hermes: "hermesw",
  hermesw: "hermesw",
  hermesp: "hermesw",
};

export function identityNameFromToken(identity: string | null | undefined) {
  const clean = (identity ?? "").trim();
  const name = clean.startsWith(IDENTITY_PREFIX)
    ? clean.slice(IDENTITY_PREFIX.length)
    : clean;
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : "";
}

export function identityTokenFromName(identity: string | null | undefined) {
  const name = identityNameFromToken(identity);
  return name ? `${IDENTITY_PREFIX}${name}` : "";
}

export function launcherForIdentity(
  harness: string,
  identity: string | null | undefined,
) {
  const clean = harness.trim();
  const name = identityNameFromToken(identity);
  if (name === "personal") return PERSONAL_LAUNCHERS[clean] ?? clean;
  if (name === "work") return WORK_LAUNCHERS[clean] ?? clean;
  return clean;
}

export function labelWithIdentity(
  label: string | null | undefined,
  identity: string | null | undefined,
) {
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
