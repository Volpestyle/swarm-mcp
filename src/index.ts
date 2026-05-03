import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  BrowserBridge,
  type ManagedBrowserContext,
  launchManagedBrowser,
  stopManagedBrowser,
} from "./browser";
import * as browserStore from "./browserStore";
import { db } from "./db";
import * as context from "./context";
import * as events from "./events";
import * as kv from "./kv";
import * as messages from "./messages";
import { file as filepath } from "./paths";
import * as planner from "./planner";
import * as prompts from "./prompts";
import { REGISTER_PROMPT, STANDBY_REGISTER_PROMPT } from "./registerPrompts";
import * as registry from "./registry";
import * as tasks from "./tasks";
import * as ui from "./ui";

let instance: registry.Instance | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let notifyTimer: ReturnType<typeof setInterval> | null = null;
let lastMsgId = 0;
let lastTaskUpdate = 0;
let lastInstancesVersion = "";
let lastKvUpdate = 0;
let lastBrowserEventId = 0;
const browserContexts = new Map<string, ManagedBrowserContext>();
let activeBrowserContextId: string | null = null;

const server = new McpServer({
  name: "swarm",
  version: "1.0.0",
});

function missing() {
  return {
    content: [
      { type: "text" as const, text: "Not registered. Call register first." },
    ],
  };
}

function registerContent(reg: registry.Instance) {
  const standby = process.env.SWARM_MCP_STARTUP_MODE?.trim() === "standby";
  const content = [
    { type: "text" as const, text: JSON.stringify(reg) },
    { type: "text" as const, text: standby ? STANDBY_REGISTER_PROMPT : REGISTER_PROMPT },
  ];
  const roleBootstrap = standby ? "" : prompts.roleBootstrap(planner.extractRole(reg.label));
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

function registeredTool<Shape extends ToolShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown> | unknown,
) {
  server.tool(
    name,
    description,
    shape,
    (async (args: z.infer<z.ZodObject<Shape>>) => {
      if (!instance) return missing();
      return handler(args);
    }) as any,
  );
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

const browserTargetShape = {
  context_id: z
    .string()
    .optional()
    .describe(
      "Managed browser context ID returned by browser_open. Defaults to the active context.",
    ),
  endpoint: z
    .string()
    .optional()
    .describe(
      "Optional Chrome DevTools endpoint or port, e.g. 9222, localhost:9222, or http://127.0.0.1:9222. Overrides context_id.",
    ),
} satisfies ToolShape;

type BrowserContextSummary = {
  id: string;
  endpoint: string;
  profileDir: string;
  pid: number | null;
  startUrl: string;
  status: string;
  active: boolean;
  managedByThisProcess: boolean;
  ownerInstanceId?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

function browserContextSummary(
  context: ManagedBrowserContext,
): BrowserContextSummary {
  return {
    id: context.id,
    endpoint: context.endpoint.baseUrl,
    profileDir: context.profileDir,
    pid: context.pid,
    startUrl: context.startUrl,
    status: "open",
    active: context.id === activeBrowserContextId,
    managedByThisProcess: true,
  };
}

function browserContextRowSummary(
  context: browserStore.BrowserContextRow,
): BrowserContextSummary {
  return {
    id: context.id,
    endpoint: context.endpoint,
    profileDir: context.profile_dir,
    pid: context.pid,
    startUrl: context.start_url,
    status: context.status,
    active: context.id === activeBrowserContextId,
    managedByThisProcess: browserContexts.has(context.id),
    ownerInstanceId: context.owner_instance_id,
    createdAt: context.created_at,
    updatedAt: context.updated_at,
  };
}

function browserContextList(scope: string): BrowserContextSummary[] {
  const persisted = browserStore.listContexts(scope);
  const seen = new Set(persisted.map((item) => item.id));
  const rows: BrowserContextSummary[] = persisted.map(browserContextRowSummary);
  for (const context of browserContexts.values()) {
    if (!seen.has(context.id)) rows.push(browserContextSummary(context));
  }
  return rows;
}

function browserTabSummary(tab: browserStore.BrowserTabRow) {
  return {
    contextId: tab.context_id,
    tabId: tab.tab_id,
    type: tab.type,
    url: tab.url,
    title: tab.title,
    active: tab.active === 1,
    updatedAt: tab.updated_at,
  };
}

function browserSnapshotSummary(
  snapshot: browserStore.BrowserSnapshotRow,
  options: { includeText?: boolean } = {},
) {
  return {
    id: snapshot.id,
    contextId: snapshot.context_id,
    tabId: snapshot.tab_id,
    url: snapshot.url,
    title: snapshot.title,
    text: options.includeText ? snapshot.text : undefined,
    textPreview: snapshot.text.slice(0, 1200),
    textLength: snapshot.text.length,
    elements: snapshot.elements.slice(0, options.includeText ? 200 : 40),
    elementCount: snapshot.elements.length,
    screenshotPath: snapshot.screenshot_path,
    createdBy: snapshot.created_by,
    createdAt: snapshot.created_at,
  };
}

function parseJsonMaybe(value: string | null) {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function uiCommandSummary(row: ui.UiCommandRow) {
  return {
    id: row.id,
    scope: row.scope,
    createdBy: row.created_by,
    kind: row.kind,
    payload: parseJsonMaybe(row.payload),
    status: row.status,
    claimedBy: row.claimed_by,
    result: parseJsonMaybe(row.result),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function browserUiCommandList(
  scope: string,
  opts: { status?: string; limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
  const args: Array<string | number> = [scope];
  const statusFilter = opts.status?.trim();
  const statusClause = statusFilter ? "AND status = ?" : "";
  if (statusFilter) args.push(statusFilter);
  args.push(limit);

  return (
    db
      .query(
        `SELECT id, scope, created_by, kind, payload, status, claimed_by, result,
                error, created_at, started_at, completed_at
         FROM ui_commands
         WHERE scope = ? AND kind LIKE 'browser.%' ${statusClause}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...args) as ui.UiCommandRow[]
  ).map(uiCommandSummary);
}

async function waitForUiCommand(id: number, waitSeconds: number) {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let row = ui.get(id);
  while (row && row.status !== "done" && row.status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    row = ui.get(id);
  }
  return row;
}

async function enqueueBrowserUiCommand(
  kind: Extract<ui.UiCommandKind, `browser.${string}`>,
  payload: Record<string, unknown>,
  waitSeconds: number,
) {
  const current = instance!;
  const id = ui.enqueue(current.scope, kind, payload, current.id);
  events.emit({
    scope: current.scope,
    type: "browser.command.enqueued",
    actor: current.id,
    subject: String(id),
    payload: {
      kind,
      wait_seconds: waitSeconds,
    },
  });
  const row = waitSeconds > 0 ? await waitForUiCommand(id, waitSeconds) : ui.get(id);
  return {
    command: row ? uiCommandSummary(row) : { id, missing: true },
    browser: browserCatalogSnapshot(current.scope),
    note:
      row?.status === "pending"
        ? "Command is queued. Start swarm-ui or keep it running to execute desktop browser intents."
        : undefined,
  };
}

function browserCatalogSnapshot(scope: string) {
  const contexts = browserContextList(scope);
  const tabs = contexts.flatMap((context) =>
    browserStore.listTabs(scope, context.id).map(browserTabSummary),
  );
  const snapshots = browserStore
    .listSnapshots(scope, undefined, 40)
    .map((snapshot) => browserSnapshotSummary(snapshot));

  return {
    activeContextId: activeBrowserContextId,
    contexts,
    tabs,
    snapshots,
    commands: browserUiCommandList(scope, { limit: 20 }),
    note:
      "Browser contexts are opt-in managed Chrome profiles. Normal personal Chrome tabs are not visible unless imported into this workbench.",
  };
}

function resolveBrowserBridge(args: {
  context_id?: string;
  endpoint?: string;
}): { bridge: BrowserBridge; context: unknown; contextId: string | null } {
  if (args.endpoint?.trim()) {
    return {
      bridge: new BrowserBridge(args.endpoint.trim()),
      context: null,
      contextId: null,
    };
  }

  const contextId = args.context_id?.trim() || activeBrowserContextId;
  if (!contextId) {
    throw new Error("No active browser context. Call browser_open first.");
  }

  const managed = browserContexts.get(contextId);
  if (managed) {
    return {
      bridge: new BrowserBridge(managed.endpoint),
      context: browserContextSummary(managed),
      contextId: managed.id,
    };
  }

  if (!instance) {
    throw new Error("Not registered. Call register first.");
  }

  const persisted = browserStore.getContext(instance.scope, contextId);
  if (!persisted) {
    throw new Error(
      `Browser context ${contextId} is not managed by this MCP process.`,
    );
  }

  return {
    bridge: new BrowserBridge(persisted.endpoint),
    context: browserContextRowSummary(persisted),
    contextId: persisted.id,
  };
}

function closeAllBrowserContexts() {
  for (const context of browserContexts.values()) {
    stopManagedBrowser(context);
    if (instance) {
      browserStore.markContextClosed(instance.scope, context.id, instance.id);
    }
  }
  browserContexts.clear();
  activeBrowserContextId = null;
}

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

function getMaxBrowserEventId() {
  if (!instance) return 0;
  const row = db
    .query(
      "SELECT MAX(id) as max FROM events WHERE scope = ? AND type LIKE 'browser.%'",
    )
    .get(instance.scope) as { max: number | null };
  return row.max ?? 0;
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

    const browserEventId = getMaxBrowserEventId();
    if (browserEventId > lastBrowserEventId) {
      lastBrowserEventId = browserEventId;
      await server.server.sendResourceUpdated({ uri: "swarm://browser" });
    }
  } catch {
    return;
  }
}

function cleanup() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);
  closeAllBrowserContexts();
  if (instance) registry.deregister(instance.id);
  instance = null;
  heartbeatTimer = null;
  notifyTimer = null;
  tasks.cleanup();
  context.cleanup();
  events.cleanup();
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

    return resource(tasks.snapshot(instance.scope), "swarm://tasks");
  },
);

server.resource(
  "instances",
  "swarm://instances",
  { description: "All active instances in this swarm scope." },
  async () => {
    if (!instance) return resource([], "swarm://instances");
    return resource(registry.list(instance.scope), "swarm://instances");
  },
);

server.resource(
  "browser",
  "swarm://browser",
  {
    description:
      "Managed browser contexts, tabs, and recent readable snapshots for this swarm scope.",
  },
  async () => {
    if (!instance)
      return resource(
        { activeContextId: null, contexts: [], tabs: [], snapshots: [] },
        "swarm://browser",
      );
    return resource(browserCatalogSnapshot(instance.scope), "swarm://browser");
  },
);

server.resource(
  "browser-snapshot",
  new ResourceTemplate("swarm://browser/snapshot{?id}", { list: undefined }),
  {
    description:
      "Full text and element details for a captured browser snapshot by snapshot id.",
  },
  async (uri, { id }) => {
    if (!instance) return resource(null, uri.href);
    const snapshotId = Array.isArray(id) ? id[0] : id;
    if (!snapshotId) {
      return resource({ error: "Missing snapshot id" }, uri.href);
    }
    const snapshot = browserStore.getSnapshot(instance.scope, String(snapshotId));
    return resource(
      snapshot
        ? browserSnapshotSummary(snapshot, { includeText: true })
        : { error: `Browser snapshot ${snapshotId} not found` },
      uri.href,
    );
  },
);

server.resource(
  "context-for-file",
  new ResourceTemplate("swarm://context{?file}", { list: undefined }),
  {
    description:
      "Shared annotations and locks for a specific file in this swarm scope.",
  },
  async (uri, { file }) => {
    if (!instance) return resource([], uri.href);
    return resource(
      context.lookup(instance.scope, resolveFileInput(file as string)),
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

server.registerPrompt(
  "browser",
  {
    title: "Swarm Browser Workbench",
    description:
      "Use managed browser contexts that agents can read and control through swarm browser tools.",
  },
  async () => prompt(prompts.browser()),
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
  },
  async ({ directory, label, scope, file_root }) => {
    if (instance) {
      return { content: registerContent(instance) };
    }

    // When launched from swarm-ui, the UI pre-creates an instance row in
    // `~/.swarm-mcp/swarm.db` (with adopted=0) and injects its id via
    // SWARM_MCP_INSTANCE_ID. `registry.register` will adopt the existing row
    // and flip `adopted=1` instead of creating a duplicate.
    const preassignedId = process.env.SWARM_MCP_INSTANCE_ID?.trim() || undefined;
    instance = registry.register(directory, label, scope, file_root, preassignedId);
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
  lastBrowserEventId = getMaxBrowserEventId();

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (notifyTimer) clearInterval(notifyTimer);

  heartbeatTimer = setInterval(() => {
    if (instance) registry.heartbeat(instance.id);
  }, 10_000);

  notifyTimer = setInterval(() => {
    void poll();
  }, 5_000);
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
    instance = registry.register(
      directory,
      envLabel,
      envScope,
      envFileRoot,
      preassignedId,
    );
    startInstanceTimers();
  } catch (err) {
    console.error("[swarm-mcp] auto-adopt failed:", err);
  }
}

tryAutoAdopt();

server.tool(
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
  async ({ label_contains }) => {
    if (!instance) return missing();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            registry.list(instance.scope, label_contains),
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  "whoami",
  "Get this instance's swarm ID and registration info.",
  {},
  async () => {
    if (!instance) return missing();
    return {
      content: [{ type: "text", text: JSON.stringify(instance, null, 2) }],
    };
  },
);

server.tool(
  "remove_instance",
  "Forcefully remove another instance from the swarm. Releases its tasks and locks.",
  {
    instance_id: z.string().describe("The instance ID to remove"),
  },
  async ({ instance_id }) => {
    if (!instance) return missing();

    if (instance_id === instance.id) {
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
    if (!target || target.scope !== instance.scope) {
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
      instance.id,
      instance.scope,
      `[auto] Instance ${label} (${instance_id}) was removed by ${instance.label ?? instance.id}. Its tasks and locks have been released.`,
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
    if (!instance) return missing();

    const id = instance.id;
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

    messages.send(current.id, current.scope, recipient, content);
    return respond(`Message sent to ${recipient}`);
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

    // Auto-notify only for newly-created tasks assigned to another session.
    if (assignee && !result.existing && assignee !== current.id) {
      const statusNote =
        result.status !== "claimed"
          ? ` (currently ${result.status} — will be claimable when ready)`
          : "";
      messages.send(
        current.id,
        current.scope,
        assignee,
        `[auto] New ${type} task assigned to you: "${title}" (task_id: ${result.id})${statusNote}. Claim it with claim_task if not auto-claimed.`,
      );
    }

    return respondJson({
      task_id: result.id,
      status: result.status,
      ...(result.existing ? { existing: true } : {}),
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
        return !!target && target.scope === current.scope;
      },
    );

    if ("error" in result) {
      return respondJson(result);
    }

    // Send auto-notifications grouped by assignee
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
    for (const [assignee, taskList] of notifs) {
      if (assignee !== current.id) {
        messages.send(
          current.id,
          current.scope,
          assignee,
          `[auto] ${taskList.length} task(s) assigned to you: ${taskList.join(", ")}. Claim open tasks with claim_task.`,
        );
      }
    }

    return respondJson(result);
  },
);

registeredTool(
  "claim_task",
  "Claim an open task to work on it.",
  { task_id: z.string().describe("The task ID to claim") },
  async ({ task_id }) => {
    const current = instance!;
    return respondJson(tasks.claim(task_id, current.scope, current.id));
  },
);

registeredTool(
  "update_task",
  "Update a task's status and optionally attach a result.",
  {
    task_id: z.string().describe("The task ID"),
    status: z.enum(["in_progress", "done", "failed", "cancelled"]).describe("New status"),
    result: z.string().optional().describe("Result or summary of work done"),
  },
  async ({ task_id, status, result }) => {
    const current = instance!;
    const next = tasks.update(
      task_id,
      current.scope,
      current.id,
      status,
      result,
    );

    // Auto-notify the requester when a task reaches a terminal state
    if ("ok" in next && (status === "done" || status === "failed")) {
      const task = tasks.get(task_id, current.scope);
      if (task && typeof task.requester === "string" && task.requester !== current.id) {
        messages.send(
          current.id,
          current.scope,
          task.requester,
          `[auto] Task "${task.title}" (${task_id}) is now ${status}.${result ? ` Result: ${result}` : ""}`,
        );
      }
    }

    return respondJson(next);
  },
);

registeredTool(
  "approve_task",
  "Approve a task in approval_required status. Transitions to open/claimed (or blocked if deps unmet).",
  { task_id: z.string().describe("The task ID to approve") },
  async ({ task_id }) => {
    const current = instance!;
    const result = tasks.approve(task_id, current.scope);

    // Auto-notify the assignee if task became claimed
    if ("ok" in result && result.status === "claimed") {
      const task = tasks.get(task_id, current.scope);
      if (
        task &&
        typeof task.assignee === "string" &&
        task.assignee !== current.id
      ) {
        messages.send(
          current.id,
          current.scope,
          task.assignee,
          `[auto] Task "${task.title}" (${task_id}) has been approved and is now claimed by you.`,
        );
      }
    }

    return respondJson(result);
  },
);

registeredTool(
  "get_task",
  "Get full details of a specific task in this swarm scope.",
  { task_id: z.string().describe("The task ID") },
  async ({ task_id }) => {
    const current = instance!;
    const task = tasks.get(task_id, current.scope);
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
  async ({ status, assignee, requester }) => {
    const current = instance!;
    return respondJson(
      tasks.list(current.scope, { status, assignee, requester }),
    );
  },
);

registeredTool(
  "annotate",
  "Share a finding, warning, or note about a file with all instances in this scope.",
  {
    file: z.string().describe("File path this annotation is about"),
    type: z
      .enum(["finding", "warning", "note", "bug", "todo"])
      .describe("Type of annotation"),
    content: z.string().describe("The annotation content"),
  },
  async ({ file, type, content }) => {
    const current = instance!;
    const id = context.annotate(
      current.id,
      current.scope,
      resolveFileInput(file),
      type,
      content,
    );
    return respondJson({ annotation_id: id });
  },
);

registeredTool(
  "lock_file",
  "Announce that you are actively working on a file. Other instances should avoid editing it.",
  {
    file: z.string().describe("File path to lock"),
    reason: z.string().optional().describe("Why you're locking it"),
  },
  async ({ file, reason }) => {
    const current = instance!;
    const path = resolveFileInput(file);
    const result = context.lock(
      current.id,
      current.scope,
      path,
      reason ?? "actively editing",
    );
    return respondJson(result);
  },
);

registeredTool(
  "unlock_file",
  "Release a file lock so other instances can edit it.",
  { file: z.string().describe("File path to unlock") },
  async ({ file }) => {
    const current = instance!;
    context.clearLocks(current.id, current.scope, resolveFileInput(file));
    return respond(`Unlocked ${file}`);
  },
);

registeredTool(
  "check_file",
  "Check if a file has any annotations, locks, or warnings from other instances in this scope.",
  { file: z.string().describe("File path to check") },
  async ({ file }) => {
    const current = instance!;
    const rows = context.lookup(current.scope, resolveFileInput(file));
    if (!rows.length)
      return {
        content: [{ type: "text", text: "No annotations for this file" }],
      };
    return respondJson(rows);
  },
);

registeredTool(
  "search_context",
  "Search all shared annotations in this scope by file path or content.",
  {
    query: z.string().describe("Search term (matches file paths and content)"),
  },
  async ({ query }) => {
    return respondJson(context.search(instance!.scope, query));
  },
);

registeredTool(
  "browser_open",
  "Launch a managed, isolated Chrome browser context that this agent can read and control through browser_* tools.",
  {
    context_id: z
      .string()
      .optional()
      .describe("Optional stable ID for this managed browser context"),
    url: z
      .string()
      .optional()
      .describe("Initial URL. Defaults to about:blank."),
    headless: z
      .boolean()
      .optional()
      .default(false)
      .describe("Launch Chrome headless. Default false for visible operator use."),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe("Optional Chrome DevTools port. Omit to auto-pick a port."),
  },
  async ({ context_id, url, headless, port }) => {
    try {
      const current = instance!;
      const contextId = context_id?.trim() || undefined;
      if (
        contextId &&
        (browserContexts.has(contextId) ||
          browserStore.getContext(current.scope, contextId))
      ) {
        return respondJson({
          error: `Browser context ${contextId} already exists`,
          contexts: browserContextList(current.scope),
        });
      }

      const managed = await launchManagedBrowser({
        id: contextId,
        url,
        headless,
        port,
      });
      browserContexts.set(managed.id, managed);
      activeBrowserContextId = managed.id;
      const persisted = browserStore.upsertContext(
        current.scope,
        current.id,
        managed,
      );

      const bridge = new BrowserBridge(managed.endpoint);
      const tabs = await bridge.listTabs();
      browserStore.recordTabs(current.scope, managed.id, tabs, current.id);
      return respondJson({
        context: browserContextRowSummary(persisted),
        tabs,
        note: "This is an isolated managed Chrome profile. Use browser_read or browser_snapshot to inspect it.",
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_contexts",
  "List browser contexts persisted in this swarm scope, including whether each is managed by this MCP process.",
  {},
  async () => respondJson(browserContextList(instance!.scope)),
);

registeredTool(
  "browser_tabs",
  "List tabs in a managed browser context or explicit Chrome DevTools endpoint.",
  browserTargetShape,
  async (args) => {
    try {
      const current = instance!;
      const { bridge, context, contextId } = resolveBrowserBridge(args);
      const tabs = await bridge.listTabs();
      if (contextId) {
        browserStore.recordTabs(current.scope, contextId, tabs, current.id);
      }
      return respondJson({
        context,
        tabs,
        persistedTabs: contextId
          ? browserStore.listTabs(current.scope, contextId)
          : [],
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_read",
  "Read the current page as agent-friendly text and key interactive elements. Does not take a screenshot.",
  {
    ...browserTargetShape,
    tab_id: z.string().optional().describe("Optional tab ID from browser_tabs"),
    max_text_length: z
      .number()
      .int()
      .min(500)
      .max(100_000)
      .optional()
      .default(24_000)
      .describe("Maximum page text characters to return"),
    max_elements: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .default(120)
      .describe("Maximum interactive/headline elements to return"),
  },
  async ({ tab_id, max_text_length, max_elements, ...target }) => {
    try {
      const current = instance!;
      const { bridge, context, contextId } = resolveBrowserBridge(target);
      const snapshot = await bridge.snapshot({
        tabId: tab_id,
        maxTextLength: max_text_length,
        maxElements: max_elements,
      });
      const persistedSnapshot = contextId
        ? browserStore.recordSnapshot(
            current.scope,
            contextId,
            snapshot,
            current.id,
          )
        : null;
      return respondJson({
        context,
        snapshot_id: persistedSnapshot?.id ?? null,
        ...snapshot,
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_snapshot",
  "Capture an agent-readable page snapshot, optionally including a PNG screenshot artifact.",
  {
    ...browserTargetShape,
    tab_id: z.string().optional().describe("Optional tab ID from browser_tabs"),
    include_screenshot: z
      .boolean()
      .optional()
      .default(true)
      .describe("Whether to save a PNG screenshot artifact. Default true."),
    out: z
      .string()
      .optional()
      .describe("Optional absolute output path for the PNG screenshot"),
    max_text_length: z
      .number()
      .int()
      .min(500)
      .max(100_000)
      .optional()
      .default(24_000)
      .describe("Maximum page text characters to return"),
    max_elements: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .default(120)
      .describe("Maximum interactive/headline elements to return"),
  },
  async ({
    tab_id,
    include_screenshot,
    out,
    max_text_length,
    max_elements,
    ...target
  }) => {
    try {
      const current = instance!;
      const { bridge, context, contextId } = resolveBrowserBridge(target);
      const snapshot = await bridge.snapshot({
        tabId: tab_id,
        includeScreenshot: include_screenshot,
        screenshotPath: out,
        maxTextLength: max_text_length,
        maxElements: max_elements,
      });
      const persistedSnapshot = contextId
        ? browserStore.recordSnapshot(
            current.scope,
            contextId,
            snapshot,
            current.id,
          )
        : null;
      return respondJson({
        context,
        snapshot_id: persistedSnapshot?.id ?? null,
        ...snapshot,
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_screenshot",
  "Save a PNG screenshot artifact for a browser tab.",
  {
    ...browserTargetShape,
    tab_id: z.string().optional().describe("Optional tab ID from browser_tabs"),
    out: z
      .string()
      .optional()
      .describe("Optional absolute output path for the PNG screenshot"),
  },
  async ({ tab_id, out, ...target }) => {
    try {
      const { bridge, context } = resolveBrowserBridge(target);
      return respondJson({
        context,
        screenshotPath: await bridge.captureScreenshot({ tabId: tab_id, out }),
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_snapshots",
  "List persisted browser snapshots in this swarm scope.",
  {
    context_id: z
      .string()
      .optional()
      .describe("Optional browser context ID to filter snapshots"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(20)
      .describe("Maximum snapshots to return"),
  },
  async ({ context_id, limit }) => {
    return respondJson(
      browserStore.listSnapshots(instance!.scope, context_id, limit),
    );
  },
);

registeredTool(
  "browser_navigate",
  "Navigate a managed browser tab to a URL.",
  {
    ...browserTargetShape,
    url: z.string().describe("Destination URL"),
    tab_id: z.string().optional().describe("Optional tab ID from browser_tabs"),
  },
  async ({ url, tab_id, ...target }) => {
    try {
      const { bridge, context } = resolveBrowserBridge(target);
      return respondJson({
        context,
        result: await bridge.navigate(url, { tabId: tab_id }),
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_click",
  "Click an element by CSS selector or visible text inside the managed browser context.",
  {
    ...browserTargetShape,
    target: z
      .string()
      .describe("CSS selector or visible text/accessible label to click"),
    tab_id: z.string().optional().describe("Optional tab ID from browser_tabs"),
  },
  async ({ target, tab_id, ...browserTarget }) => {
    try {
      const { bridge, context } = resolveBrowserBridge(browserTarget);
      return respondJson({
        context,
        result: await bridge.click(target, { tabId: tab_id }),
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_type",
  "Type text into an input by CSS selector, visible label, accessible label, or placeholder.",
  {
    ...browserTargetShape,
    target: z
      .string()
      .describe("CSS selector, visible label, accessible label, or placeholder"),
    text: z.string().describe("Text to put into the target field"),
    tab_id: z.string().optional().describe("Optional tab ID from browser_tabs"),
  },
  async ({ target, text, tab_id, ...browserTarget }) => {
    try {
      const { bridge, context } = resolveBrowserBridge(browserTarget);
      return respondJson({
        context,
        result: await bridge.typeText(target, text, { tabId: tab_id }),
      });
    } catch (err) {
      return respondJson({ error: String(err) });
    }
  },
);

registeredTool(
  "browser_close",
  "Close a managed browser context launched by this MCP process.",
  {
    context_id: z
      .string()
      .optional()
      .describe("Managed context ID. Defaults to the active context."),
  },
  async ({ context_id }) => {
    const current = instance!;
    const contextId = context_id?.trim() || activeBrowserContextId;
    if (!contextId) return respondJson({ error: "No active browser context" });
    const managed = browserContexts.get(contextId);
    if (!managed) {
      const persisted = browserStore.getContext(current.scope, contextId);
      return respondJson({
        error: persisted
          ? `Browser context ${contextId} is not owned by this MCP process; refusing to mark it closed without killing it.`
          : `Browser context ${contextId} not found`,
        context: persisted ? browserContextRowSummary(persisted) : null,
      });
    }
    const signaled = stopManagedBrowser(managed);
    browserContexts.delete(contextId);
    const persisted = browserStore.markContextClosed(
      current.scope,
      contextId,
      current.id,
    );
    if (activeBrowserContextId === contextId) {
      activeBrowserContextId = browserContexts.keys().next().value ?? null;
    }
    return respondJson({
      closed: contextId,
      signaled,
      context: persisted ? browserContextRowSummary(persisted) : null,
      contexts: browserContextList(current.scope),
    });
  },
);

const browserUiWaitShape = {
  wait_seconds: z
    .number()
    .min(0)
    .max(120)
    .optional()
    .default(0)
    .describe(
      "Optional seconds to wait for swarm-ui to claim and finish the command. Default 0 returns immediately after enqueue.",
    ),
} satisfies ToolShape;

registeredTool(
  "browser_ui_open",
  "Ask the running swarm-ui desktop workbench to open a visible managed browser context in this swarm scope.",
  {
    url: z
      .string()
      .optional()
      .describe("URL to open. Defaults to about:blank when omitted."),
    ...browserUiWaitShape,
  },
  async ({ url, wait_seconds }) =>
    respondJson(
      await enqueueBrowserUiCommand(
        "browser.open",
        { url: url?.trim() || null },
        wait_seconds,
      ),
    ),
);

registeredTool(
  "browser_ui_import_active_tab",
  "Ask swarm-ui to import the front Google Chrome tab into a managed browser context. This uses the operator's macOS Automation permission boundary.",
  browserUiWaitShape,
  async ({ wait_seconds }) =>
    respondJson(
      await enqueueBrowserUiCommand(
        "browser.import-active-tab",
        {},
        wait_seconds,
      ),
    ),
);

registeredTool(
  "browser_ui_capture_snapshot",
  "Ask swarm-ui to capture a readable snapshot from a UI-managed browser context. If context_id is omitted, the desktop worker uses the newest open context.",
  {
    context_id: z
      .string()
      .optional()
      .describe("Browser context ID. Defaults to the newest open UI context."),
    tab_id: z
      .string()
      .optional()
      .describe("Optional tab ID from browser tabs."),
    ...browserUiWaitShape,
  },
  async ({ context_id, tab_id, wait_seconds }) =>
    respondJson(
      await enqueueBrowserUiCommand(
        "browser.capture-snapshot",
        {
          context_id: context_id?.trim() || null,
          tab_id: tab_id?.trim() || null,
        },
        wait_seconds,
      ),
    ),
);

registeredTool(
  "browser_ui_close",
  "Ask swarm-ui to close a UI-managed browser context. If context_id is omitted, the desktop worker closes the newest open context.",
  {
    context_id: z
      .string()
      .optional()
      .describe("Browser context ID. Defaults to the newest open UI context."),
    ...browserUiWaitShape,
  },
  async ({ context_id, wait_seconds }) =>
    respondJson(
      await enqueueBrowserUiCommand(
        "browser.close",
        { context_id: context_id?.trim() || null },
        wait_seconds,
      ),
    ),
);

registeredTool(
  "browser_ui_commands",
  "List or inspect browser desktop-workbench commands queued through swarm-ui.",
  {
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional command ID to inspect."),
    status: z
      .enum(["pending", "running", "done", "failed"])
      .optional()
      .describe("Optional status filter when listing commands."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe("Maximum commands to list."),
  },
  async ({ id, status, limit }) => {
    const current = instance!;
    if (id) {
      const row = ui.get(id);
      if (!row || row.scope !== current.scope || !row.kind.startsWith("browser.")) {
        return respondJson({ error: `Browser UI command ${id} not found` });
      }
      return respondJson(uiCommandSummary(row));
    }
    return respondJson(browserUiCommandList(current.scope, { status, limit }));
  },
);

registeredTool(
  "kv_get",
  "Get a value from the shared key-value store for this scope.",
  { key: z.string().describe("The key to look up") },
  async ({ key }) => {
    const row = kv.get(instance!.scope, key);
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
    kv.set(instance!.scope, key, value, instance!.id);
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
  async ({ prefix }) => {
    return respondJson(kv.keys(instance!.scope, prefix));
  },
);

server.tool(
  "wait_for_activity",
  "Block until new swarm activity arrives (messages, task changes, KV changes, browser updates, or instance changes), then return what changed. Use this as your idle loop to stay autonomous without user prompting. Returns immediately if there is already unread activity.",
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
  async ({ timeout_seconds }) => {
    if (!instance) return missing();

    // Check for already-unread messages before snapshotting — return
    // immediately so auto-notifications that arrived before this call
    // are not missed.
    const existing = messages.peek(instance.id, instance.scope, 50);
    if (existing.length > 0) {
      const result: Record<string, unknown> = {
        changes: ["new_messages"],
        messages: messages.poll(instance!.id, instance!.scope, 50),
        tasks: tasks.snapshot(instance!.scope),
      };
      return respond(JSON.stringify(result, null, 2));
    }

    events.emit({
      scope: instance.scope,
      type: "agent.waiting",
      actor: instance.id,
      subject: instance.id,
      payload: { timeout_seconds },
    });

    const startMsgId = getMaxMsgId();
    const startTaskUpdate = getMaxTaskUpdate();
    const startInstancesVersion = getInstancesVersion();
    const startKvUpdate = getMaxKvUpdate();
    const startBrowserEventId = getMaxBrowserEventId();

    const deadline = timeout_seconds > 0 ? Date.now() + timeout_seconds * 1000 : 0;
    const pollInterval = 2000; // check every 2 seconds

    while (deadline === 0 || Date.now() < deadline) {
      const currentMsgId = getMaxMsgId();
      const currentTaskUpdate = getMaxTaskUpdate();
      const currentInstancesVersion = getInstancesVersion();
      const currentKvUpdate = getMaxKvUpdate();
      const currentBrowserEventId = getMaxBrowserEventId();

      const changes: string[] = [];
      if (currentMsgId > startMsgId) changes.push("new_messages");
      if (currentTaskUpdate > startTaskUpdate) changes.push("task_updates");
      if (currentInstancesVersion !== startInstancesVersion)
        changes.push("instance_changes");
      if (currentKvUpdate > startKvUpdate) changes.push("kv_updates");
      if (currentBrowserEventId > startBrowserEventId)
        changes.push("browser_updates");

      if (changes.length > 0) {
        // Collect the actual updates to return
        const result: Record<string, unknown> = { changes };

        if (changes.includes("new_messages")) {
          result.messages = messages.poll(instance!.id, instance!.scope, 50);
        }
        if (changes.includes("task_updates")) {
          result.tasks = tasks.snapshot(instance!.scope);
        }
        if (changes.includes("instance_changes")) {
          result.instances = registry.list(instance!.scope);
        }
        if (changes.includes("browser_updates")) {
          result.browser = browserCatalogSnapshot(instance!.scope);
        }

        events.emit({
          scope: instance.scope,
          type: "agent.wait_returned",
          actor: instance.id,
          subject: instance.id,
          payload: { changes, timeout: false },
        });

        return respond(JSON.stringify(result, null, 2));
      }

      // Sleep before next check
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout with no changes
    events.emit({
      scope: instance.scope,
      type: "agent.wait_returned",
      actor: instance.id,
      subject: instance.id,
      payload: { changes: [], timeout: true },
    });

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
