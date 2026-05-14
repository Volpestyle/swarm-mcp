/**
 * Identity boundary helpers shared by registry, dispatch, and write-path
 * handlers. The control-plane contract treats each `identity:<profile>` token
 * as a hard delegation boundary: tasks, messages, and prompts that cross
 * identities are forbidden.
 *
 * These helpers are intentionally label-based. The launched process root (its
 * config dir, MCP auth, and AGENT_IDENTITY env) is the underlying source of
 * truth; the swarm label is the routing/audit surface and what we can compare
 * server-side.
 */
export type LabelOwner = { label: string | null } | null | undefined;

const IDENTITY_PREFIX = "identity:";

export function identityToken(owner: LabelOwner): string {
  return (
    (owner?.label ?? "")
      .split(/\s+/)
      .find((token) => token.startsWith(IDENTITY_PREFIX)) ?? ""
  );
}

export function identityName(owner: LabelOwner): string {
  const token = identityToken(owner);
  return token ? token.slice(IDENTITY_PREFIX.length) : "";
}

export function sameIdentityReason(
  actor: LabelOwner,
  owner: LabelOwner,
): string | null {
  return crossIdentityReason(actor, owner);
}

export function processIdentity(): string {
  const raw = (process.env.AGENT_IDENTITY ?? "").trim();
  return raw ? `${IDENTITY_PREFIX}${raw}` : "";
}

/**
 * Returns a non-null reason string when coordination from `sender` to `target`
 * should be rejected because their identity tokens conflict or one side is
 * unlabeled. Use SWARM_MCP_ALLOW_UNLABELED=1 for legacy unlabeled sessions.
 */
export function crossIdentityReason(
  sender: LabelOwner,
  target: LabelOwner,
): string | null {
  if (envTruthy("SWARM_MCP_ALLOW_CROSS_IDENTITY")) return null;
  const a = identityToken(sender);
  const b = identityToken(target);
  if (!a || !b) {
    if (envTruthy("SWARM_MCP_ALLOW_UNLABELED")) return null;
    return `Identity boundary blocked: ${!a ? "sender" : "target"} has no identity token. Add an identity:<name> label or set SWARM_MCP_ALLOW_UNLABELED=1 from a trusted shell.`;
  }
  if (a === b) return null;
  return `Cross-identity coordination blocked: sender ${a}, target ${b}. Delegation across the identity boundary is forbidden (see swarm-mcp/docs/control-plane.md). Set SWARM_MCP_ALLOW_CROSS_IDENTITY=1 to override from a trusted shell.`;
}

export function identityMatches(actor: LabelOwner, owner: LabelOwner): boolean {
  return crossIdentityReason(actor, owner) === null;
}

function envTruthy(name: string) {
  return /^(1|true|yes|on)$/i.test((process.env[name] ?? "").trim());
}
