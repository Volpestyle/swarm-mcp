import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCleanup } from "./cleanup";
import { db } from "./db";
import * as context from "./context";
import * as dispatch from "./dispatch";
import { crossIdentityReason } from "./identity";
import * as kv from "./kv";
import * as messages from "./messages";
import { file as filepath, norm, scope as scopeFor } from "./paths";
import * as planner from "./planner";
import * as prompts from "./prompts";
import * as registry from "./registry";
import * as spawnerBackend from "./spawner_backend";
import { registerDefaultSpawners } from "./spawner_defaults";
import * as tasks from "./tasks";
import * as workspaceIdentity from "./workspace_identity";
import * as workTracker from "./work_tracker";
import { herdrWorkspaceBackend } from "./backends/herdr";

workspaceIdentity.registerBackend(herdrWorkspaceBackend);
registerDefaultSpawners();

let instance: registry.Instance | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let notifyTimer: ReturnType<typeof setInterval> | null = null;
let lastMsgId = 0;
let lastTaskUpdate = 0;
let lastInstancesVersion = "";
let lastKvUpdate = 0;

const server = new McpServer({
  name: "swarm",
  version: "1.0.0",
});

const REGISTER_PROMPT = `You are now registered with the swarm and should operate in autonomous mode.

Rehydrate first with bootstrap, then handle unread messages before claiming or creating work.
Use wait_for_activity only while you own active monitoring responsibility, such as a delegated task, dependency, review, lock release, or peer response.
If no active responsibility remains, finish the turn and remain promptable instead of looping. Deregister only when exiting or no longer available.`;

function missing() {
  return {
    content: [
      { type: "text" as const, text: "Not registered. Call register first." },
    ],
  };
}

function registerContent(reg: registry.Instance) {
  const content = [
    { type: "text" as const, text: JSON.stringify(reg) },
    { type: "text" as const, text: REGISTER_PROMPT },
  ];
  const roleBootstrap = prompts.roleBootstrap(planner.extractRole(reg.label));
  if (roleBootstrap) {
    content.push({ type: "text" as const, text: roleBootstrap });
  }
  return content;
}

function respond(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function respondJson(value: unknown) {
  return respond(JSON.stringify(value, null, 2));
}

function autoPromptPeer(opts: {
  scope: string;
  sender: string;
  recipient: string;
  message: string;
  task?: string;
}) {
  return dispatch.promptPeerResult({
    ...opts,
    nudge: true,
    force: false,
  });
}

function assignedBlockedTasks(scope: string, viewer: registry.Instance) {
  const blocked = new Map<string, { assignee: string; title: string; type: string }>();
  for (const task of tasks.list(scope, { status: "blocked", viewer })) {
    const id = typeof task.id === "string" ? task.id : "";
    const assignee = typeof task.assignee === "string" ? task.assignee : "";
    const title = typeof task.title === "string" ? task.title : "";
    const type = typeof task.type === "string" ? task.type : "";
    if (id && assignee) blocked.set(id, { assignee, title, type });
  }
  return blocked;
}

function notifyAssignedUnblockedTasks(opts: {
  scope: string;
  sender: string;
  viewer: registry.Instance;
  before: Map<string, { assignee: string; title: string; type: string }>;
}) {
  const prompts: Array<Record<string, unknown>> = [];
  for (const task of tasks.list(opts.scope, { status: "claimed", viewer: opts.viewer })) {
    const id = typeof task.id === "string" ? task.id : "";
    const assignee = typeof task.assignee === "string" ? task.assignee : "";
    if (!id || !assignee || assignee === opts.sender) continue;
    const prior = opts.before.get(id);
    if (!prior || prior.assignee !== assignee) continue;

    prompts.push({
      task_id: id,
      recipient: assignee,
      prompt: autoPromptPeer({
        scope: opts.scope,
        sender: opts.sender,
        recipient: assignee,
        task: id,
        message: `[auto] Task "${prior.title}" (${id}) is unblocked and claimed by you. Call claim_task to start it.`,
      }),
    });
  }
  return prompts;
}

function resource<T>(text: T, uri: string) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(text, null, 2),
      },
    ],
  };
}

function prompt(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text,
        },
      },
    ],
  };
}

type ToolShape = Record<string, z.ZodTypeAny>;

type ToolMetadata = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
};

function registeredTool<Shape extends ToolShape>(
  name: string,
  description: string,
  shape: Shape,
  handlerOrMetadata:
    | ((args: z.infer<z.ZodObject<Shape>>) => Promise<unknown> | unknown)
    | ToolMetadata,
  maybeHandler?: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown> | unknown,
) {
  const metadata =
    typeof handlerOrMetadata === "function" ? undefined : handlerOrMetadata;
  const handler =
    typeof handlerOrMetadata === "function"
      ? handlerOrMetadata
      : maybeHandler!;

  const wrapped = (async (args: z.infer<z.ZodObject<Shape>>) => {
    if (!ensureInstance()) return missing();
    return handler(args);
  }) as any;

  if (metadata) {
    (server.tool as any)(name, description, shape, metadata, wrapped);
  } else {
    server.tool(name, description, shape, wrapped);
  }
}

const taskTypeSchema = z.enum(tasks.TASK_TYPES);
const taskStatusSchema = z.enum(tasks.TASK_STATUSES);
const taskCreateShape = {
  type: taskTypeSchema.describe("Type of task"),
  title: z.string().describe("Short title for the task"),
  description: z
    .string()
    .optional()
    .describe("Detailed description of what needs to be done"),
  files: z.array(z.string()).optional().describe("Relevant file paths"),
  assignee: z
    .string()
    .optional()
    .describe("Specific instance ID to assign to, or omit for any taker"),
  priority: z
    .number()
    .int()
    .optional()
    .default(0)
    .describe(
      "Priority level. Higher = more urgent. Default 0. Agents claim highest-priority open tasks first.",
    ),
  depends_on: z
    .array(z.string())
    .optional()
    .describe(
      "Task IDs this task depends on. Task stays blocked until all dependencies reach done.",
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Unique key to prevent duplicate task creation. If a task with this key exists, returns the existing task.",
    ),
  parent_task_id: z
    .string()
    .optional()
    .describe("Optional parent task ID for tree-structured work tracking."),
  approval_required: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, task starts in approval_required status and must be approved before work begins.",
    ),
} satisfies ToolShape;

function resolveFileInput(file: string) {
  if (!instance) return filepath("", file);
  return filepath(instance.directory, file, {
    fileRoot: instance.file_root,
    root: instance.root,
  });
}

function getMaxMsgId() {
  if (!instance) return 0;
  const row = db
    .query(
      "SELECT MAX(id) as max FROM messages WHERE scope = ? AND recipient = ? AND read = 0",
    )
    .get(instance.scope, instance.id) as { max: number | null };
  return row.max ?? 0;
}

function getMaxTaskUpdate() {
  if (!instance) return 0;
  const row = db
    .query("SELECT MAX(changed_at) as max FROM tasks WHERE scope = ?")
    .get(instance.scope) as {
    max: number | null;
  };
  return row.max ?? 0;
}

function getInstancesVersion() {
  if (!instance) return "";
  const row = db
    .query(
      "SELECT COUNT(*) as count, COALESCE(MAX(registered_at), 0) as max FROM instances WHERE scope = ?",
    )
    .get(instance.scope) as { count: number; max: number };
  return `${row.count}:${row.max}`;
}

function getMaxKvUpdate() {
  if (!instance) return 0;
  return kv.version(instance.scope);
}

async function poll() {
  if (!instance) return;

  try {
    const msgId = getMaxMsgId();
    if (msgId > lastMsgId) {
      lastMsgId = msgId;
      await server.server.sendResourceUpdated({ uri: "swarm://inbox" });
    }

    const taskUpdate = getMaxTaskUpdate();
    if (taskUpdate > lastTaskUpdate) {
      lastTaskUpdate = taskUpdate;
      await server.server.sendResourceUpdated({ uri: "swarm://tasks" });
    }

    const instancesVersion = getInstancesVersion();
    if (instancesVersion !== lastInstancesVersion) {
      lastInstancesVersion = instancesVersion;
      await server.server.sendResourceUpdated({ uri: "swarm://instances" });
    }
  } catch {
    return;
  }
}

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  if (instance) registry.deregister(instance.id);
  instance = null;
  heartbeatTimer = null;
  notifyTimer = null;
  runCleanup({ mode: "manual" });
}

server.resource(
  "inbox",
  "swarm://inbox",
  {
    description:
      "Unread messages for this instance. Auto-updates when new messages arrive.",
  },
  async () => {
    if (!instance) return resource([], "swarm://inbox");
    return resource(
      messages.peek(instance.id, instance.scope),
      "swarm://inbox",
    );
  },
);

server.resource(
  "tasks",
  "swarm://tasks",
  { description: "Open and active tasks in this swarm scope." },
  async () => {
    if (!instance)
      return resource(
        {
          open: [],
          claimed: [],
          in_progress: [],
          blocked: [],
          approval_required: [],
          done: [],
          failed: [],
          cancelled: [],
        },
        "swarm://tasks",
      );

    return resource(tasks.snapshot(instance.scope, {}, instance), "swarm://tasks");
  },
);

server.resource(
  "instances",
  "swarm://instances",
  { description: "All active instances in this swarm scope." },
  async () => {
    if (!instance) return resource([], "swarm://instances");
    return resource(registry.listVisible(instance), "swarm://instances");
  },
);

server.resource(
  "lock-for-file",
  new ResourceTemplate("swarm://lock{?file}", { list: undefined }),
  {
    description: "Active lock state for a specific file in this swarm scope.",
  },
  async (uri, { file }) => {
    if (!instance) return resource([], uri.href);
    return resource(
      context.fileLock(instance.scope, resolveFileInput(file as string)),
      uri.href,
    );
  },
);

server.registerPrompt(
  "setup",
  {
    title: "Swarm Setup",
    description:
      "Register this agent session and inspect current swarm state.",
  },
  async () => prompt(prompts.setup()),
);

server.registerPrompt(
  "protocol",
  {
    title: "Swarm Protocol",
    description:
      "Apply the recommended cross-agent coordination workflow for this session.",
  },
  async () => prompt(prompts.protocol()),
);

server.tool(
  "register",
  "Register this agent session with the swarm. Call this first before using other tools.",
  {
    directory: z
      .string()
      .describe("The project directory this instance is working in"),
    label: z
      .string()
      .optional()
      .describe("Optional friendly label for this instance"),
    scope: z
      .string()
      .optional()
      .describe(
        "Optional shared swarm scope. Defaults to the detected git root.",
      ),
    file_root: z
      .string()
      .optional()
      .describe(
        "Optional canonical base directory for resolving relative file paths. Useful when multiple worktrees should share one logical file tree.",
      ),
    adopt_instance_id: z
      .string()
      .optional()
      .describe(
        "Optional existing leased instance ID to adopt instead of creating a fresh registration.",
      ),
  },
  async ({ directory, label, scope, file_root, adopt_instance_id }) => {
    const adoptId = adopt_instance_id?.trim() || undefined;
    if (adoptId && (!instance || instance.id !== adoptId)) {
      const adopted = tryAdoptExplicitRegistration(adoptId, {
        directory,
        label,
        scope,
      });
      if (adopted) return { content: registerContent(adopted) };
      if (instance) {
        return respondJson({
          error: `Could not adopt instance ${adoptId}; keeping current registration`,
          instance,
        });
      }
    }

    if (instance) {
      return { content: registerContent(instance) };
    }

    // When launched from swarm-ui, the UI pre-creates an instance row in
    // `~/.swarm-mcp/swarm.db` (with adopted=0) and injects its id via
    // SWARM_MCP_INSTANCE_ID. `registry.register` will adopt the existing row
    // and flip `adopted=1` instead of creating a duplicate.
    const preassignedId = process.env.SWARM_MCP_INSTANCE_ID?.trim() || undefined;
    instance = registry.register(
      directory,
      label,
      scope,
      file_root,
      preassignedId,
      adoptId,
    );
    startInstanceTimers();

    return { content: registerContent(instance) };
  },
);

function startInstanceTimers() {
  if (!instance) return;
  lastMsgId = getMaxMsgId();
  lastTaskUpdate = getMaxTaskUpdate();
  lastInstancesVersion = getInstancesVersion();
  lastKvUpdate = getMaxKvUpdate();

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);

  heartbeatTimer = setInterval(() => {
    if (instance) registry.heartbeat(instance.id);
  }, 10_000);

  notifyTimer = setInterval(() => {
    void poll();
  }, 5_000);
}

function bindInstance(next: registry.Instance) {
  instance = next;
  startInstanceTimers();
  return instance;
}

function tryAdoptExplicitRegistration(
  adoptId: string,
  opts: {
    directory?: string;
    label?: string;
    scope?: string;
  } = {},
) {
  if (!adoptId) return null;
  const directory =
    opts.directory ?? process.env.SWARM_MCP_DIRECTORY?.trim() ?? process.cwd();
  const scope = opts.scope ?? process.env.SWARM_MCP_SCOPE?.trim() ?? undefined;
  const label = opts.label ?? process.env.SWARM_MCP_LABEL?.trim() ?? undefined;
  try {
    const adopted = registry.adoptInstanceId(directory, label, scope, adoptId);
    return adopted ? bindInstance(adopted) : null;
  } catch (err) {
    console.error("[swarm-mcp] explicit registration adoption failed:", err);
    return null;
  }
}

/**
 * When swarm-ui spawns the host process (claude/codex/opencode), it
 * pre-creates an instance row with adopted=0 and injects its id via
 * SWARM_MCP_INSTANCE_ID. The row stays as "ADOPTING" in the UI until this
 * server adopts it — but MCP clients only call the `register` tool on
 * demand, not at startup, so we auto-adopt here so the pill flips to
 * adopted as soon as the MCP server boots, not whenever the user first
 * prompts the agent to use swarm tools.
 *
 * Directory/scope/label come from env vars also injected by swarm-ui, with
 * a fallback to `process.cwd()` (the PTY cwd) so manual invocations with
 * only SWARM_MCP_INSTANCE_ID still work.
 */
function tryAutoAdopt() {
  const preassignedId = process.env.SWARM_MCP_INSTANCE_ID?.trim();
  if (!preassignedId || instance) return;

  const directory = process.env.SWARM_MCP_DIRECTORY?.trim() || process.cwd();
  const envScope = process.env.SWARM_MCP_SCOPE?.trim() || undefined;
  const envLabel = process.env.SWARM_MCP_LABEL?.trim() || undefined;
  const envFileRoot = process.env.SWARM_MCP_FILE_ROOT?.trim() || undefined;

  try {
    bindInstance(
      registry.register(
        directory,
        envLabel,
        envScope,
        envFileRoot,
        preassignedId,
      ),
    );
  } catch (err) {
    console.error("[swarm-mcp] auto-adopt failed:", err);
  }
}

function tryAdoptLeasedRegistration() {
  if (instance) return;

  const directory = norm(
    process.env.SWARM_MCP_DIRECTORY?.trim() || process.cwd(),
  );
  const envScope = process.env.SWARM_MCP_SCOPE?.trim() || undefined;
  const scope = scopeFor(directory, envScope);
  const envFileRoot = process.env.SWARM_MCP_FILE_ROOT?.trim() || undefined;

  const candidates = db
    .query(
      `SELECT id, scope, directory, root, file_root, pid, label, adopted, lease_until
       FROM instances
       WHERE scope = ?
         AND directory = ?
         AND label LIKE '%session:%'
         AND adopted = 0
         AND lease_until IS NOT NULL
         AND lease_until > unixepoch()
       ORDER BY registered_at ASC`,
    )
    .all(scope, directory) as Array<
      Omit<registry.Instance, "adopted"> & {
        adopted: number;
        lease_until: number | null;
      }
    >;

  if (candidates.length !== 1) return;

  const candidate = candidates[0];
  try {
    bindInstance(
      registry.register(
        candidate.directory,
        candidate.label ?? undefined,
        candidate.scope,
        envFileRoot ?? candidate.file_root,
        candidate.id,
      ),
    );
  } catch (err) {
    console.error("[swarm-mcp] leased registration adoption failed:", err);
  }
}

function ensureInstance() {
  if (instance) {
    if (registry.get(instance.id)) return instance;
    instance = null;
  }
  tryAutoAdopt();
  if (instance) return instance;
  tryAdoptLeasedRegistration();
  return instance;
}

tryAutoAdopt();

(server.tool as any)(
  "list_instances",
  "List all currently active agent sessions in this swarm scope.",
  {
    label_contains: z
      .string()
      .optional()
      .describe(
        "Filter instances whose label contains this substring (e.g. 'role:implementer')",
      ),
  },
  { readOnlyHint: true },
  async ({ label_contains }: { label_contains?: string }) => {
    const current = ensureInstance();
    if (!current) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            registry.listVisible(current, label_contains),
            null,
            2,
          ),
        },
      ],
    };
  },
);

(server.tool as any)(
  "whoami",
  "Get this instance's swarm ID and registration info.",
  {},
  { readOnlyHint: true },
  async () => {
    const current = ensureInstance();
    if (!current) return missing();
    return {
      content: [{ type: "text", text: JSON.stringify(current, null, 2) }],
    };
  },
);

(server.tool as any)(
  "bootstrap",
  "Atomic 'where am I?' for swarm state. Returns this instance, peers (excluding self), unread messages, and the task snapshot in one call. Use this on session start, after compaction, or any time you need to rejoin and rehydrate. By default consumes unread messages (mark-as-read); pass mark_read=false to peek.",
  {
    mark_read: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "When true (default), unread messages are returned and marked read (matches poll_messages). When false, messages are peeked and remain unread.",
      ),
    adopt_instance_id: z
      .string()
      .optional()
      .describe(
        "Optional existing leased instance ID to adopt before returning the bootstrap snapshot.",
      ),
    include_terminal: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "When true, include full terminal task rows. Default false keeps bootstrap compact and returns terminal_counts only.",
      ),
    terminal_limit: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe(
        "Maximum terminal rows per status to include when include_terminal=false. Default 0 returns counts only.",
      ),
  },
  { readOnlyHint: false, idempotentHint: false },
  async ({
    mark_read,
    adopt_instance_id,
    include_terminal,
    terminal_limit,
  }: {
    mark_read?: boolean;
    adopt_instance_id?: string;
    include_terminal?: boolean;
    terminal_limit?: number;
  }) => {
    const adoptId = adopt_instance_id?.trim() || undefined;
    if (adoptId && (!instance || instance.id !== adoptId)) {
      tryAdoptExplicitRegistration(adoptId);
    }
    const current = ensureInstance();
    if (!current) return missing();
    const peers = registry.listVisible(current).filter(
      (p) => p.id !== current.id,
    );
    const unread = mark_read
      ? messages.poll(current.id, current.scope, 50)
      : messages.peek(current.id, current.scope, 50);
    return respondJson({
      instance: current,
      peers,
      unread_messages: unread,
      tasks: tasks.snapshot(current.scope, {
        include_terminal,
        terminal_limit,
      }, current),
      work_tracker: workTracker.configuredWorkTracker(current.scope, current.label),
    });
  },
);

server.tool(
  "remove_instance",
  "Forcefully remove another instance from the swarm. Releases its tasks and locks.",
  {
    instance_id: z.string().describe("The instance ID to remove"),
  },
  async ({ instance_id }) => {
    const current = ensureInstance();
    if (!current) return missing();

    if (instance_id === current.id) {
      return {
        content: [
          {
            type: "text",
            text: "Cannot remove yourself. Use deregister instead.",
          },
        ],
      };
    }

    const target = registry.get(instance_id);
    if (!target || target.scope !== current.scope) {
      return {
        content: [
          {
            type: "text",
            text: `Instance ${instance_id} not found in this scope`,
          },
        ],
      };
    }

    const label = target.label ?? target.id;
    registry.deregister(instance_id);

    // Notify remaining instances
    messages.broadcast(
      current.id,
      current.scope,
      `[auto] Instance ${label} (${instance_id}) was removed by ${current.label ?? current.id}. Its tasks and locks have been released.`,
    );

    return respond(
      `Removed instance ${label} (${instance_id}). Tasks released, locks cleared.`,
    );
  },
);

server.tool(
  "deregister",
  "Remove this instance from the swarm and clean up its tasks and locks.",
  {},
  async () => {
    const current = ensureInstance();
    if (!current) return missing();

    const id = current.id;
    cleanup();

    return {
      content: [
        {
          type: "text",
          text: `Deregistered instance ${id}. Tasks released, locks cleared.`,
        },
      ],
    };
  },
);

registeredTool(
  "send_message",
  "Send a message to a specific instance by ID.",
  {
    recipient: z.string().describe("The instance ID to send the message to"),
    content: z.string().describe("The message content"),
  },
  async ({ recipient, content }) => {
    const current = instance!;

    const target = registry.get(recipient);
    if (!target || target.scope !== current.scope) {
      return {
        content: [
          {
            type: "text",
            text: `Instance ${recipient} is not active in this scope`,
          },
        ],
      };
    }

    if (target.id === current.id) {
      return {
        content: [{ type: "text", text: "Cannot send a message to yourself" }],
      };
    }

    const crossId = crossIdentityReason(current, target);
    if (crossId) {
      return { content: [{ type: "text", text: crossId }] };
    }

    messages.send(current.id, current.scope, recipient, content);
    return respond(`Message sent to ${recipient}`);
  },
);

registeredTool(
  "prompt_peer",
  "Send a durable swarm message to another instance, then best-effort wake its published workspace handle when supported. By default, busy handles are not interrupted; use force only for urgent or corrective updates.",
  {
    recipient: z.string().describe("Target swarm instance id"),
    message: z.string().describe("Instruction to send through swarm"),
    task_id: z.string().optional().describe("Optional related swarm task id"),
    nudge: z.boolean().optional().default(true).describe("Whether to wake the target workspace handle"),
    force: z.boolean().optional().default(false).describe("Wake even when the target workspace handle is working; reserve for urgent or corrective updates"),
  },
  async ({ recipient, message, task_id, nudge, force }) => {
    const current = instance!;
    const target = registry.get(recipient);
    if (!target || target.scope !== current.scope) {
      return respondJson({ error: `Instance ${recipient} is not active in this scope` });
    }
    if (target.id === current.id) {
      return respondJson({ error: "Cannot prompt yourself" });
    }

    const crossId = crossIdentityReason(current, target);
    if (crossId) {
      return respondJson({ error: crossId });
    }

    return respondJson(
      dispatch.promptPeerResult({
        scope: current.scope,
        sender: current.id,
        recipient: target.id,
        message,
        task: task_id,
        nudge,
        force,
      }),
    );
  },
);

registeredTool(
  "resolve_workspace_handle",
  "Resolve a transport-local workspace handle to the matching swarm instance by validating published workspace identity mappings.",
  {
    backend: z
      .string()
      .optional()
      .default("herdr")
      .describe("Workspace backend name. The current bundled backend is herdr."),
    handle_kind: z
      .string()
      .optional()
      .default("pane")
      .describe("Type of workspace handle, such as pane"),
    handle: z.string().describe("Transport-local workspace handle from the backend"),
    validate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Validate published identities through the backend and repair stale aliases"),
  },
  async ({ backend, handle_kind, handle, validate }) => {
    const current = instance!;
    return respondJson(
      workspaceIdentity.resolveWorkspaceHandleToSwarm({
        scope: current.scope,
        backend,
        handleKind: handle_kind,
        handle,
        actor: current.id,
        validate,
      }),
    );
  },
);

registeredTool(
  "broadcast",
  "Send a message to all other active instances in this swarm scope.",
  { content: z.string().describe("The message content to broadcast") },
  async ({ content }) => {
    const current = instance!;
    const count = messages.broadcast(current.id, current.scope, content);
    return respond(`Broadcast sent to ${count} instance(s)`);
  },
);

registeredTool(
  "poll_messages",
  "Check for new incoming messages. Returns unread messages and marks them as read.",
  {
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .default(50)
      .describe("Max messages to return"),
  },
  async ({ limit }) => {
    const current = instance!;
    return respondJson(messages.poll(current.id, current.scope, limit));
  },
);

registeredTool(
  "request_task",
  "Create a task for another instance, or leave it open for any instance in this scope.",
  taskCreateShape,
  async ({
    type,
    title,
    description,
    files,
    assignee,
    priority,
    depends_on,
    idempotency_key,
    parent_task_id,
    approval_required,
  }) => {
    const current = instance!;

    if (assignee) {
      const target = registry.get(assignee);
      if (!target || target.scope !== current.scope) {
        return {
          content: [
            {
              type: "text",
              text: `Instance ${assignee} is not active in this scope`,
            },
          ],
        };
      }
      const crossId = crossIdentityReason(current, target);
      if (crossId) {
        return { content: [{ type: "text", text: crossId }] };
      }
    }

    const result = tasks.request(current.id, current.scope, type, title, {
      description,
      files: files?.map((item) => resolveFileInput(item)),
      assignee,
      priority,
      depends_on,
      idempotency_key,
      parent_task_id,
      approval_required,
    });

    if ("error" in result) {
      return { content: [{ type: "text", text: result.error }] };
    }

    let promptResult: Record<string, unknown> | null = null;
    // Auto-notify and wake only for newly-created tasks assigned to another session.
    if (assignee && !result.existing && assignee !== current.id) {
      const statusNote =
        result.status !== "claimed"
          ? ` (currently ${result.status} — will be claimable when ready)`
          : "";
      promptResult = autoPromptPeer({
        scope: current.scope,
        sender: current.id,
        recipient: assignee,
        task: result.id,
        message: `[auto] New ${type} task assigned to you: "${title}" (task_id: ${result.id})${statusNote}. Claim it with claim_task if not auto-claimed.`,
      });
    }

    return respondJson({
      task_id: result.id,
      status: result.status,
      ...(result.existing ? { existing: true } : {}),
      ...(promptResult ? { prompt: promptResult } : {}),
    });
  },
);

registeredTool(
  "request_task_batch",
  "Create multiple tasks atomically in a single transaction. Supports $N references (1-indexed) for dependencies between tasks in the batch. Rolls back entirely on validation failure.",
  {
    tasks: z
      .array(
        z.object(taskCreateShape),
      )
      .min(1)
      .max(50)
      .describe("Array of task specifications. $N references are 1-indexed positional refs within this array."),
  },
  async ({ tasks: taskSpecs }) => {
    const current = instance!;

    // Resolve file paths
    const resolved = taskSpecs.map((spec) => ({
      ...spec,
      files: spec.files?.map((f) => resolveFileInput(f)),
    }));

    const result = tasks.requestBatch(
      current.id,
      current.scope,
      resolved,
      (assigneeId) => {
        const target = registry.get(assigneeId);
        if (!target || target.scope !== current.scope) return false;
        if (crossIdentityReason(current, target)) return false;
        return true;
      },
    );

    if ("error" in result) {
      return respondJson(result);
    }

    // Send auto-notifications grouped by assignee, with best-effort wakeups.
    const notifs = new Map<string, string[]>();
    for (let i = 0; i < taskSpecs.length; i++) {
      const spec = taskSpecs[i];
      const taskResult = result.tasks[i];
      if (spec.assignee && taskResult.new) {
        const list = notifs.get(spec.assignee) ?? [];
        const statusNote =
          taskResult.status !== "claimed"
            ? ` (${taskResult.status})`
            : "";
        list.push(`"${spec.title}" (${spec.type}, task_id: ${taskResult.id})${statusNote}`);
        notifs.set(spec.assignee, list);
      }
    }
    const prompts: Array<Record<string, unknown>> = [];
    for (const [assignee, taskList] of notifs) {
      if (assignee !== current.id) {
        prompts.push({
          recipient: assignee,
          prompt: autoPromptPeer({
            scope: current.scope,
            sender: current.id,
            recipient: assignee,
            message: `[auto] ${taskList.length} task(s) assigned to you: ${taskList.join(", ")}. Claim open tasks with claim_task.`,
          }),
        });
      }
    }

    return respondJson({ ...result, ...(prompts.length ? { prompts } : {}) });
  },
);

registeredTool(
  "dispatch",
  "Gateway-only: create/reuse a task, wake a live worker, or spawn a worker through the configured spawner.",
  {
    title: z.string().describe("Short title for the task to dispatch"),
    message: z
      .string()
      .optional()
      .describe("Instructions sent to the worker; defaults to title"),
    type: taskTypeSchema.optional().default("implement").describe("Task type"),
    role: z
      .string()
      .optional()
      .default("implementer")
      .describe("Worker role token without the role: prefix"),
    files: z.array(z.string()).optional().describe("Relevant file paths"),
    priority: z.number().int().optional().describe("Task priority"),
    depends_on: z.array(z.string()).optional().describe("Dependency task IDs"),
    idempotency_key: z.string().optional().describe("Dedupe key"),
    parent_task_id: z.string().optional().describe("Parent task ID"),
    approval_required: z.boolean().optional().default(false),
    spawn: z
      .boolean()
      .optional()
      .default(true)
      .describe("When false, create/wake only; do not spawn a worker"),
    force_spawn: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Skip live-worker matching and go straight to the spawn path. Use when you explicitly want a fresh worker pane even if a generalist or matching peer exists.",
      ),
    spawner: z
      .string()
      .optional()
      .describe("Spawner backend: herdr (default) or swarm-ui"),
    harness: z.string().optional().describe("Launcher/harness for spawned worker"),
    cwd: z
      .string()
      .optional()
      .describe("Spawn cwd; defaults to this instance directory"),
    label: z.string().optional().describe("Additional label for spawned worker"),
    name: z.string().optional().describe("Display name for spawned worker"),
    wait_seconds: z
      .number()
      .min(0)
      .optional()
      .describe("Seconds to wait for worker spawn/adoption; defaults depend on spawner"),
    nudge: z.boolean().optional().default(true).describe("Wake live worker handle"),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Wake even when target workspace handle is busy"),
  },
  async (args) => {
    const current = instance!;
    try {
      return respondJson(
        await dispatch.runDispatch({
          scope: current.scope,
          requester: current.id,
          title: args.title,
          message: args.message,
          description: args.message,
          type: args.type,
          role: args.role,
          files: args.files?.map((item) => resolveFileInput(item)),
          priority: args.priority,
          depends_on: args.depends_on,
          idempotency_key: args.idempotency_key,
          parent_task_id: args.parent_task_id,
          approval_required: args.approval_required,
          spawn: args.spawn,
          force_spawn: args.force_spawn,
          spawner: args.spawner,
          cwd: args.cwd ?? current.directory,
          harness: args.harness,
          label: args.label,
          name: args.name,
          wait_seconds: args.wait_seconds,
          nudge: args.nudge,
          force: args.force,
        }),
      );
    } catch (err) {
      return respondJson({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

registeredTool(
  "claim_task",
  "Start work on a task: assigns it to you (if open) and transitions to in_progress in one call. Works on open+unassigned tasks and on tasks pre-assigned to you (status=claimed).",
  {
    task_id: z.string().describe("The task ID to claim"),
    ignore_unread_messages: z
      .boolean()
      .optional()
      .describe(
        "Set true only when intentionally claiming despite unread messages. Default false blocks claiming until poll_messages is called.",
      ),
  },
  async ({ task_id, ignore_unread_messages }) => {
    const current = instance!;
    return respondJson(
      tasks.claim(task_id, current.scope, current.id, {
        ignoreUnreadMessages: ignore_unread_messages,
      }),
    );
  },
);

registeredTool(
  "update_task",
  "Move a claimed/in_progress task to a terminal status (done, failed, cancelled). claim_task already transitions to in_progress, so this is the single completion call. Auto-releases this instance's locks on the task's files.",
  {
    task_id: z.string().describe("The task ID"),
    status: z.enum(["done", "failed", "cancelled"]).describe("Terminal status"),
    result: z.string().optional().describe("Result or summary of work done"),
  },
  async ({ task_id, status, result }) => {
    const current = instance!;
    const blockedBefore = status === "done" ? assignedBlockedTasks(current.scope, current) : new Map();
    const next = tasks.update(
      task_id,
      current.scope,
      current.id,
      status,
      result,
    );

    if (!("ok" in next)) return respondJson(next);

    const response: Record<string, unknown> = { ...next };

    // Auto-notify and wake the requester when a task reaches a terminal state.
    if ("ok" in next && (status === "done" || status === "failed")) {
      const task = tasks.get(task_id, current.scope, current);
      if (task && typeof task.requester === "string" && task.requester !== current.id) {
        response.prompt = autoPromptPeer({
          scope: current.scope,
          sender: current.id,
          recipient: task.requester,
          task: task_id,
          message: `[auto] Task "${task.title}" (${task_id}) is now ${status}.${result ? ` Result: ${result}` : ""}`,
        });
      }
    }

    if (status === "done") {
      const unblockedPrompts = notifyAssignedUnblockedTasks({
        scope: current.scope,
        sender: current.id,
        viewer: current,
        before: blockedBefore,
      });
      if (unblockedPrompts.length) response.unblocked_prompts = unblockedPrompts;
    }

    return respondJson(response);
  },
);

registeredTool(
  "approve_task",
  "Approve a task in approval_required status. Transitions to open/claimed (or blocked if deps unmet).",
  { task_id: z.string().describe("The task ID to approve") },
  async ({ task_id }) => {
    const current = instance!;
    const result = tasks.approve(task_id, current.scope, current.id);

    // Auto-notify and wake the assignee if task became claimed.
    let promptResult: Record<string, unknown> | null = null;
    if ("ok" in result && result.status === "claimed") {
      const task = tasks.get(task_id, current.scope, current);
      if (
        task &&
        typeof task.assignee === "string" &&
        task.assignee !== current.id
      ) {
        promptResult = autoPromptPeer({
          scope: current.scope,
          sender: current.id,
          recipient: task.assignee,
          task: task_id,
          message: `[auto] Task "${task.title}" (${task_id}) has been approved and is now claimed by you.`,
        });
      }
    }

    return respondJson({ ...result, ...(promptResult ? { prompt: promptResult } : {}) });
  },
);

registeredTool(
  "get_task",
  "Get full details of a specific task in this swarm scope.",
  { task_id: z.string().describe("The task ID") },
  { readOnlyHint: true },
  async ({ task_id }) => {
    const current = instance!;
    const task = tasks.get(task_id, current.scope, current);
    if (!task) return { content: [{ type: "text", text: "Task not found" }] };
    return respondJson(task);
  },
);

registeredTool(
  "list_tasks",
  "List tasks in this swarm scope, optionally filtered by status, assignee, or requester.",
  {
    status: taskStatusSchema.optional(),
    assignee: z.string().optional().describe("Filter by assignee instance ID"),
    requester: z
      .string()
      .optional()
      .describe("Filter by requester instance ID"),
  },
  { readOnlyHint: true },
  async ({ status, assignee, requester }) => {
    const current = instance!;
    return respondJson(
       tasks.list(current.scope, { status, assignee, requester, viewer: current }),
    );
  },
);

registeredTool(
  "get_file_lock",
  "Read active lock state for a file without acquiring an edit lock. Use this for review, planning, or conflict inspection when you are not about to edit the file.",
  {
    file: z.string().describe("File path to inspect"),
  },
  { readOnlyHint: true },
  async ({ file }) => {
    const current = instance!;
    return respondJson(context.fileLock(current.scope, resolveFileInput(file), current));
  },
);

registeredTool(
  "lock_file",
  "Acquire an edit lock on a file. Returns the new lock id on success or the active lock owner on conflict. Normal edit locks held by this instance are auto-released when their task reaches a terminal state via update_task. Pass task_id to associate the lock with a specific task — terminal release will then pick it up by task_id regardless of whether the file appears in the task's declared files list (use this when editing files outside the original task.files set). Pass exclusive=true to require that no lock exists on the file (including one held by this same instance) — useful for one-shot operations like spawn mutexes where same-instance re-entry is itself a conflict.",
  {
    file: z.string().describe("File path to lock"),
    reason: z.string().optional().describe("Why you're locking it"),
    task_id: z
      .string()
      .optional()
      .describe(
        "Optional task ID to associate this lock with. When the named task reaches a terminal status via update_task, locks tagged with this task_id are released regardless of whether the file is in task.files.",
      ),
    exclusive: z
      .boolean()
      .optional()
      .describe(
        "If true, conflict on ANY existing lock for the file — including one held by this same instance. Default false keeps re-entrant semantics.",
      ),
  },
  async ({ file, reason, task_id, exclusive }) => {
    const current = instance!;
    const path = resolveFileInput(file);
    const result = context.lock(
      current.id,
      current.scope,
      path,
      reason ?? "actively editing",
      { exclusive: exclusive ?? false, taskId: task_id?.trim() || undefined },
    );
    return respondJson(result);
  },
);

registeredTool(
  "unlock_file",
  "Release a file lock early. Locks are auto-released on terminal update_task, so call this only when you finish a file before the task as a whole.",
  { file: z.string().describe("File path to unlock") },
  async ({ file }) => {
    const current = instance!;
    context.clearLocks(current.id, current.scope, resolveFileInput(file));
    return respond(`Unlocked ${file}`);
  },
);

registeredTool(
  "kv_get",
  "Get a value from the shared key-value store for this scope.",
  { key: z.string().describe("The key to look up") },
  { readOnlyHint: true },
  async ({ key }) => {
    const row = kv.get(instance!.scope, key, instance!.id);
    if (!row)
      return { content: [{ type: "text", text: `Key \"${key}\" not found` }] };
    return respondJson(row);
  },
);

registeredTool(
  "kv_set",
  "Set a value in the shared key-value store for this scope.",
  {
    key: z.string().describe("The key to set"),
    value: z
      .string()
      .describe("The value to store (use JSON for complex data)"),
  },
  async ({ key, value }) => {
    const result = kv.set(instance!.scope, key, value, instance!.id);
    if (result && "error" in result) return respondJson(result);
    return respond(`Set \"${key}\"`);
  },
);

registeredTool(
  "kv_append",
  "Atomically append a value to a JSON array in the KV store. Creates the key with [value] if it doesn't exist. If the existing value is not an array, wraps it in one first.",
  {
    key: z.string().describe("The key to append to"),
    value: z
      .string()
      .describe("The value to append (must be valid JSON)"),
  },
  async ({ key, value }) => {
    try {
      JSON.parse(value);
    } catch {
      return {
        content: [{ type: "text", text: "Value must be valid JSON" }],
      };
    }
    const length = kv.append(instance!.scope, key, value, instance!.id);
    return respond(`Appended to \"${key}\" (${length} items)`);
  },
);

registeredTool(
  "kv_delete",
  "Delete a key from the shared key-value store for this scope.",
  { key: z.string().describe("The key to delete") },
  async ({ key }) => {
    kv.del(instance!.scope, key, instance!.id);
    return respond(`Deleted \"${key}\"`);
  },
);

registeredTool(
  "kv_list",
  "List keys in the shared key-value store for this scope, optionally filtered by prefix.",
  {
    prefix: z.string().optional().describe("Optional key prefix to filter by"),
  },
  { readOnlyHint: true },
  async ({ prefix }) => {
    return respondJson(kv.keys(instance!.scope, prefix, instance!.id));
  },
);

(server.tool as any)(
  "wait_for_activity",
  "Block until new swarm activity arrives (messages, task changes, KV changes, or instance changes), then return what changed. Use this only while you own active monitoring responsibility, not as a generic idle loop. Returns immediately if there is already unread activity. Note: returned messages are marked read.",
  {
    timeout_seconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe(
        "Max seconds to wait before returning (even if nothing changed). Default 0 means wait indefinitely.",
      ),
  },
  { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  async ({ timeout_seconds = 0 }: { timeout_seconds?: number }) => {
    const current = ensureInstance();
    if (!current) return missing();

    // Check for already-unread messages before snapshotting — return
    // immediately so auto-notifications that arrived before this call
    // are not missed.
    const existing = messages.peek(current.id, current.scope, 50);
    if (existing.length > 0) {
      const result: Record<string, unknown> = {
        changes: ["new_messages"],
        messages: messages.poll(current.id, current.scope, 50),
        tasks: tasks.snapshot(current.scope, {}, current),
      };
      return respond(JSON.stringify(result, null, 2));
    }

    const startMsgId = getMaxMsgId();
    const startTaskUpdate = getMaxTaskUpdate();
    const startInstancesVersion = getInstancesVersion();
    const startKvUpdate = getMaxKvUpdate();

    const deadline = timeout_seconds > 0 ? Date.now() + timeout_seconds * 1000 : 0;
    const pollInterval = 2000; // check every 2 seconds

    while (deadline === 0 || Date.now() < deadline) {
      const currentMsgId = getMaxMsgId();
      const currentTaskUpdate = getMaxTaskUpdate();
      const currentInstancesVersion = getInstancesVersion();
      const currentKvUpdate = getMaxKvUpdate();

      const changes: string[] = [];
      if (currentMsgId > startMsgId) changes.push("new_messages");
      if (currentTaskUpdate > startTaskUpdate) changes.push("task_updates");
      if (currentInstancesVersion !== startInstancesVersion)
        changes.push("instance_changes");
      if (currentKvUpdate > startKvUpdate) changes.push("kv_updates");

      if (changes.length > 0) {
        // Collect the actual updates to return
        const result: Record<string, unknown> = { changes };

        if (changes.includes("new_messages")) {
          result.messages = messages.poll(instance!.id, instance!.scope, 50);
        }
        if (changes.includes("task_updates")) {
          result.tasks = tasks.snapshot(instance!.scope, {}, instance!);
        }
        if (changes.includes("instance_changes")) {
          result.instances = registry.listVisible(instance!);
        }

        return respond(JSON.stringify(result, null, 2));
      }

      // Sleep before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout with no changes
    return respond(
      JSON.stringify({
        changes: [],
        timeout: true,
        message: "No new activity within timeout.",
      }),
    );
  },
);

async function main() {
  const transport = new StdioServerTransport();
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
  await server.connect(transport);
}

main().catch((err) => {
  console.error("swarm-mcp fatal:", err);
  process.exit(1);
});
