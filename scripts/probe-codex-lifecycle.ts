import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { once } from "node:events";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { CoordinationClient } from "../src/coordination/ipc";

const [capture, executable] = process.argv.slice(2);
if (!capture || !executable)
  throw new Error(
    "Usage: probe-codex-lifecycle <capture.json> <native codex executable>",
  );
const root = mkdtempSync(join(tmpdir(), "swarm-codex-probe-"));
const home = join(root, "codex");
mkdirSync(home);
mkdirSync(resolve("dist/test"), { recursive: true });
const bundles = mkdtempSync(resolve("dist/test/codex-mcp-"));
for (const name of ["owner-cli", "mcp-cli"])
  await build({
    entryPoints: [`src/coordination/${name}.ts`],
    outfile: join(bundles, `${name}.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
const enrolled = await enrollRuntime({
  stateDirectory: join(root, "private"),
  nodePath: Bun.which("node")!,
  ownerPath: join(bundles, "owner-cli.mjs"),
  host: "codex",
  hostSessionId: "app-server-fixture",
  incarnation: "initial",
  identity: {
    projectRoot: root,
    directory: root,
    fileRoot: root,
    profile: "fixture",
    allowedRoots: [root],
  },
});
const coordinator = await CoordinationClient.connect(
  enrolled.environment.SWARM_COORDINATOR_ENDPOINT,
  enrolled.environment.SWARM_SESSION_CAPABILITY,
);
writeFileSync(
  join(home, "config.toml"),
  `model = "fixture"
model_provider = "fixture"
[model_providers.fixture]
name = "local fixture (no inference)"
base_url = "http://127.0.0.1:1"
wire_api = "responses"
requires_openai_auth = false
[mcp_servers.swarm]
command = ${JSON.stringify(Bun.which("node"))}
args = [${JSON.stringify(join(bundles, "mcp-cli.mjs"))}]
env_vars = ["SWARM_COORDINATOR_ENDPOINT", "SWARM_SESSION_CAPABILITY"]
`,
);
const configured = JSON.parse(
  readFileSync("integrations/codex/plugins/swarm/hooks.json", "utf8"),
);
for (const groups of Object.values(configured.hooks) as Array<
  Array<{ hooks: Array<{ command: string }> }>
>)
  for (const group of groups)
    for (const hook of group.hooks)
      hook.command = "node -e \"process.stdout.write('{}')\"";
writeFileSync(join(home, "hooks.json"), JSON.stringify(configured));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(CODEX|OPENAI|SWARM_|HERDR)/i.test(key),
  ),
);
env.CODEX_HOME = home;
Object.assign(env, enrolled.environment);
const child = Bun.spawn({
  cmd: [executable, "app-server"],
  cwd: root,
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const pending = new Map<
  number,
  { resolve: (result: any) => void; reject: (error: Error) => void }
>();
const notices: string[] = [];
let sequence = 0;
const send = (message: unknown) =>
  child.stdin.write(JSON.stringify(message) + "\n");
const read = (async () => {
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const wait = pending.get(message.id);
      if (wait) {
        pending.delete(message.id);
        if (message.error)
          wait.reject(new Error(JSON.stringify(message.error)));
        else wait.resolve(message.result);
      } else if (message.method) notices.push(message.method);
    }
  }
})();
const stderr = new Response(child.stderr).text();
const call = (method: string, params: unknown) => {
  const id = ++sequence;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send({ id, method, params });
  });
};
try {
  const initialized = await call("initialize", {
    clientInfo: { name: "swarm_lifecycle_probe", version: "1" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const hooks = await call("hooks/list", { cwds: [root] });
  const loaded = hooks.data[0];
  if (
    loaded.errors.length ||
    loaded.hooks.length !== Object.keys(configured.hooks).length ||
    !loaded.hooks.some(
      (hook: { eventName: string }) => hook.eventName === "sessionEnd",
    ) ||
    loaded.hooks.some(
      (hook: { eventName: string }) => hook.eventName === "stop",
    )
  )
    throw new Error("Codex hook lifecycle mapping was not loaded correctly");
  const started = await call("thread/start", {
    cwd: root,
    model: "fixture",
    modelProvider: "fixture",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = started.thread.id;
  const inventory = await call("mcpServerStatus/list", {
    threadId,
    limit: 100,
    detail: "toolsAndAuthOnly",
  });
  const swarm = inventory.data.find(
    (server: { name: string }) => server.name === "swarm",
  );
  const tools = Object.keys(swarm?.tools ?? {}).sort();
  if (!tools.includes("swarm_inbox"))
    throw new Error("Codex did not discover the coordinator inbox tool");
  const invoke = async (tool: string, arguments_: unknown) => {
    const result = await call("mcpServer/tool/call", {
      threadId,
      server: "swarm",
      tool,
      arguments: arguments_,
    });
    if (result.isError) throw new Error("Codex MCP tool reported an error");
    return result.structuredContent.data;
  };
  const sync = await invoke("swarm_sync", {});
  if (sync.actor !== enrolled.actor)
    throw new Error("Codex MCP actor mismatch");
  const sent = (await coordinator.request({
    op: "command",
    command: {
      id: "codex-mcp-message",
      type: "message.send",
      payload: {
        recipient: enrolled.actor,
        kind: "question",
        body: "Codex native MCP roundtrip",
      },
    },
  })) as { value: { messageId: string } };
  const fetched = await invoke("swarm_inbox", {
    commandId: "codex-fetch",
    action: "fetch",
    consumer: "codex-app-server-probe",
  });
  const lease = fetched.value.deliveries[0];
  if (lease.message.id !== sent.value.messageId)
    throw new Error("Codex fetched another message");
  const beforeAck = (await coordinator.request({
    op: "message_status",
    messageId: lease.message.id,
  })) as { deliveries: Array<{ state: string }> };
  if (beforeAck.deliveries[0].state !== "leased")
    throw new Error("Codex fetch did not retain an unacknowledged lease");
  await invoke("swarm_inbox", {
    commandId: "codex-ack",
    action: "ack",
    messageId: lease.message.id,
    leaseToken: lease.leaseToken,
  });
  const status = (await coordinator.request({
    op: "message_status",
    messageId: lease.message.id,
  })) as { deliveries: Array<{ state: string }> };
  if (status.deliveries[0].state !== "acknowledged")
    throw new Error("Codex MCP acknowledgment did not commit");
  const snapshot = await call("thread/read", { threadId }).catch(
    (error: Error) => ({ error: error.message }),
  );
  const idleSteer = await call("turn/steer", {
    threadId,
    expectedTurnId: "not-active",
    input: [{ type: "text", text: "fixture" }],
  }).then(
    () => "unexpected acceptance",
    (error: Error) => error.message,
  );
  const unsubscribe = await call("thread/unsubscribe", { threadId });
  const evidence = {
    version: new TextDecoder()
      .decode(Bun.spawnSync([executable, "--version"]).stdout)
      .trim(),
    initialized,
    hooks,
    threadId,
    status: started.thread.status,
    readBeforeFirstTurn: snapshot,
    idleSteer,
    unsubscribe,
    notifications: [...new Set(notices)],
    inferenceRequested: false,
    mcp: {
      tools,
      actorMatched: true,
      stateBeforeExplicitAck: beforeAck.deliveries[0].state,
      stateAfterExplicitAck: status.deliveries[0].state,
      identityBinding: "fixture enrollment; not automatic native-thread lifecycle",
      driver: "thread-scoped app-server MCP call; no model turn",
    },
  };
  writeFileSync(capture, JSON.stringify(evidence, null, 2) + "\n");
  if (idleSteer === "unexpected acceptance")
    throw new Error("Idle steering unexpectedly accepted");
  console.log(capture);
} finally {
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 3000);
  await child.exited;
  clearTimeout(timeout);
  await read;
  await stderr;
  coordinator.close();
  if (enrolled.launchedOwner) {
    enrolled.launchedOwner.ref();
    const exited = once(enrolled.launchedOwner, "exit");
    enrolled.launchedOwner.kill();
    await exited;
  }
}
