import { ownerState, agentState } from "./launcher-state";
import { launcherIdentity } from "./sessions";
import { ensureCoordinator } from "./owner-launcher";
import { CoordinationClient, localEndpoint } from "./ipc";
import { requireText } from "./errors";

/** Trusted launcher configuration only. Reuse incarnation when retrying an
 * uncertain launch; supply a new one for a real host restart/resume. */
export async function enrollRuntime(options: {
  stateDirectory: string;
  nodePath: string;
  ownerPath: string;
  identity: Parameters<typeof launcherIdentity>[0];
  host: "codex" | "claude-code" | "hermes" | "opencode";
  hostSessionId: string;
  incarnation: string;
  label?: string;
}) {
  requireText(options.incarnation, "incarnation");
  requireText(options.hostSessionId, "hostSessionId", 4096);
  if (!["codex", "claude-code", "hermes", "opencode"].includes(options.host))
    throw new Error("Unknown runtime host");
  const identity = launcherIdentity(options.identity);
  const owner = await ownerState(options.stateDirectory);
  const agent = await agentState(
    options.stateDirectory,
    identity.scope,
    options.host,
    options.hostSessionId,
  );
  const connected = await ensureCoordinator({
    configPath: owner.configPath,
    nodePath: options.nodePath,
    ownerPath: options.ownerPath,
  });
  try {
    const session = (await connected.client.request({
      op: "enroll",
      input: {
        scope: identity.scope,
        agentId: agent.agentId,
        requestId: options.incarnation,
        resumeToken: agent.resumeToken,
        label: options.label ?? `runtime:${options.host}`,
        worktree: { root: identity.fileRoot, repository: identity.projectRoot },
      },
    })) as {
      actor: string;
      scope: string;
      sessionId: string;
      generation: number;
      capability: string;
      replayed: boolean;
    };
    const endpoint = localEndpoint(owner.databasePath);
    const verification = await CoordinationClient.connect(
      endpoint,
      session.capability,
    );
    try {
      await verification.request({ op: "bootstrap" });
    } finally {
      verification.close();
    }
    // Construct the child environment explicitly: neither retained resume token
    // nor owner launcher secret belongs in a model-facing host process.
    return {
      actor: session.actor,
      scope: session.scope,
      sessionId: session.sessionId,
      generation: session.generation,
      replayed: session.replayed,
      environment: {
        SWARM_COORDINATOR_ENDPOINT: endpoint,
        SWARM_SESSION_CAPABILITY: session.capability,
      },
      launchedOwner: connected.launched,
    };
  } finally {
    connected.client.close();
  }
}
