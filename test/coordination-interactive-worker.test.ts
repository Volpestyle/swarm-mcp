import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, readdir, mkdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { ownerState } from "../src/coordination/launcher-state";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { herdrDispatchProvider } from "../src/coordination/herdr-dispatch";
import { ownerDispatchSchema } from "../src/coordination/owner-dispatch";
import { CoordinationClient } from "../src/coordination/ipc";
import { prepareClaudeLaunch } from "../src/coordination/claude-launcher";

type Logged = { at: number; type: string; [key: string]: any };
const node = () => Bun.which("node")!;

/** A Herdr runtime whose layout.apply really starts the wrapper, which starts
 * the interactive fixture with inherited stdio (ADR 0194). */
async function fleet(options: { ignoreReadiness?: boolean; readinessTimeoutMs: number }) {
  await mkdir(resolve("dist/test"), { recursive: true });
  const packageRoot = await mkdtemp(resolve("dist/test/interactive-"));
  const dist = join(packageRoot, "dist/coordination");
  await cp("skills/swarm-mcp", join(packageRoot, "skills/swarm-mcp"), { recursive: true });
  await build({ entryPoints: ["owner-cli", "claude-hook-cli", "client-cli", "mcp-cli", "herdr-worker-cli"].map(name => `src/coordination/${name}.ts`),
    bundle: true, platform: "node", format: "esm", packages: "external", outdir: dist });
  const root = realpathSync(await mkdtemp("/tmp/swarm-interactive-test-"));
  const owner = await ownerState(root);
  const herdr = join(root, "herdr");
  await writeFile(herdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'workspace') console.log(JSON.stringify({result:{root_pane:{pane_id:'w1:p1'},tab:{tab_id:'w1:t1'}}}));
else if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({result:{pane_id:args[2]}}));
else process.exit(2);
`, { mode: 0o700 });
  const claude = join(root, "claude-fixture");
  await writeFile(claude, "#!/usr/bin/env node\n" + await readFile("test/fixtures/interactive-worker-harness.cjs", "utf8"), { mode: 0o700 });
  const fixtureLog = join(root, "fixture.jsonl");
  const wrappers: ReturnType<typeof spawn>[] = [];
  const layouts: any[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      layouts.push(request);
      const wrapper = spawn(node(), [join(dist, "herdr-worker-cli.js"), request.params.root.command[2]], {
        env: { ...process.env, HERDR_PANE_ID: "w1:p2", FIXTURE_LOG: fixtureLog,
          ...(options.ignoreReadiness ? { FIXTURE_IGNORE_READINESS: "1" } : {}) },
        stdio: ["ignore", "pipe", "pipe"] });
      wrapper.stdout!.resume(); wrapper.stderr!.resume();
      wrappers.push(wrapper);
      socket.end(JSON.stringify({ id: request.id, result: { layout: { root: { pane_id: "w1:p2" } } } }) + "\n");
    });
  });
  await new Promise<void>(done => server.listen(join(root, "herdr.sock"), done));
  const route = { id: "herdr", stateDirectory: root, readinessTimeoutMs: options.readinessTimeoutMs, profile: "test",
    socketPath: join(root, "herdr.sock"), herdrPath: herdr, claudePath: claude, nodePath: node(),
    workerPath: join(dist, "herdr-worker-cli.js"), capabilities: ["code"], capacity: 2, workerMode: "interactive" as const };
  await writeFile(owner.configPath, JSON.stringify({ version: 1, ...owner, dispatch: { maximum: 4, observationMaxAgeMs: 60000, peers: [], herdr: [route] } }));
  const lead = await enrollRuntime({ stateDirectory: root, nodePath: node(), ownerPath: join(dist, "owner-cli.js"),
    host: "pi", hostSessionId: "leader", incarnation: "launch", identity: { projectRoot: root, fileRoot: root, directory: root, profile: "test" } });
  const client = await CoordinationClient.connect(lead.environment.SWARM_COORDINATOR_ENDPOINT, lead.environment.SWARM_SESSION_CAPABILITY);
  const fixture = async (): Promise<Logged[]> => {
    try { return (await readFile(fixtureLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch { return []; }
  };
  const until = async (predicate: (log: Logged[]) => boolean, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const log = await fixture();
      if (predicate(log)) return log;
      if (Date.now() > deadline) throw new Error(`Fixture did not reach the expected state:\n${JSON.stringify(log, null, 1)}`);
      await new Promise(done => setTimeout(done, 100));
    }
  };
  const receipt = async () => {
    const name = (await readdir(root)).find(entry => /^herdr-[a-f0-9-]{36}[.]json$/.test(entry))!;
    return { path: join(root, name), record: JSON.parse(await readFile(join(root, name), "utf8")) };
  };
  const intent = (intentId: string, execution?: { mode?: "interactive" | "stream" }) => ({ intentId, title: "Trivial", capabilities: ["code"], durable: true,
    contract: { objective: "Finish a trivial task", worktree: root, acceptanceCriteria: ["Fenced outcome"], expectedArtifacts: [], constraints: [] },
    ...(execution ? { execution } : {}) });
  const close = async () => {
    for (const wrapper of wrappers) if (wrapper.exitCode === null) {
      wrapper.kill("SIGTERM");
      await new Promise(done => wrapper.once("exit", done));
    }
    client.close();
    server.close();
  };
  return { root, owner, client, layouts, wrappers, fixture, until, receipt, intent, close };
}

test("interactive worker: channel readiness, leased envelopes, one outstanding, fenced finish", async () => {
  if (process.platform === "win32") return;
  const f = await fleet({ readinessTimeoutMs: 20000 });
  try {
    const bound = await f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("interactive-one") } }) as any;
    expect(bound).toMatchObject({ status: "bound", executionMode: "interactive" });
    const { path, record } = await f.receipt();
    expect(record.mode).toBe("interactive");
    expect(record.environment.SWARM_STREAM_WORKER).toBeUndefined();
    expect(record.environment.SWARM_MCP_CHANNEL).toBe("1");
    expect(record.args).toContain("--dangerously-load-development-channels");
    // The intent row, not the route's current setting, owns the resolved mode.
    const db = new Database(f.owner.databasePath, { readonly: true });
    expect(db.prepare("SELECT execution_mode FROM dispatch_intents WHERE intent_id='interactive-one'").get()).toEqual({ execution_mode: "interactive" });
    db.close();
    // Readiness proof is the channel nonce, not any tool call.
    let log = await f.until(entries => {
      const finished = entries.findIndex(entry => entry.type === "finished");
      return finished >= 0 && entries.slice(finished).some(entry => entry.type === "hook" && entry.event === "Stop");
    });
    const argv = log.find(entry => entry.type === "argv")!.args as string[];
    for (const flag of ["--print", "--input-format", "--output-format", "stream-json"]) expect(argv).not.toContain(flag);
    expect(argv).toEqual(expect.arrayContaining(["--permission-mode", "auto", "--append-system-prompt"]));
    expect(log.find(entry => entry.type === "initialized")!.channel).toBe(true);
    expect(log.find(entry => entry.type === "early_sync")).toMatchObject({ isError: true });
    expect(log.find(entry => entry.type === "early_sync")!.text).toContain("readiness_pending");
    expect(log.find(entry => entry.type === "wrong_nonce")).toMatchObject({ isError: true });
    expect(log.find(entry => entry.type === "ready")).toMatchObject({ isError: false });
    expect(log.find(entry => entry.type === "envelope")).toMatchObject({ kind: "task.assigned" });
    expect(log.find(entry => entry.type === "finished")).toMatchObject({ isError: false });
    const task = await f.client.request({ op: "task_detail", taskId: bound.taskId }) as any;
    expect(task.status).toBe("completed");
    const health = JSON.parse(await readFile(`${path}.mcp-health`, "utf8"));
    expect(health.state).toBe("ready");
    // Lifecycle hooks published the native turn; they did not consume mail.
    expect(JSON.parse(await readFile(`${path}.turn`, "utf8"))).toMatchObject({ state: "idle", sessionId: record.environment.SWARM_NATIVE_SESSION_ID });
    expect(log.filter(entry => entry.type === "hook").map(entry => entry.event)).toEqual(expect.arrayContaining(["UserPromptSubmit", "Stop"]));
    // Two peer messages: the second envelope waits for the first acknowledgement.
    for (const n of [1, 2]) await f.client.request({ op: "command", command: { id: `peer-${n}`, type: "message.send",
      payload: { recipient: record.worker.actor, kind: "peer.note", body: `note ${n}` } } });
    log = await f.until(entries => entries.filter(entry => entry.type === "acking").length === 2);
    const envelopes = log.filter(entry => entry.type === "envelope" && entry.kind === "peer.note");
    expect(envelopes).toHaveLength(2);
    const firstAck = log.find(entry => entry.type === "acking")!;
    expect(envelopes[1]!.at).toBeGreaterThanOrEqual(firstAck.at);
    expect(new Set(envelopes.map(entry => entry.messageId)).size).toBe(2);
    expect(f.layouts).toHaveLength(1);
    expect(f.wrappers[0]!.exitCode).toBeNull();
  } finally { await f.close(); }
}, 60000);

test("interactive startup that never answers stays blocked in interactive mode and never falls back", async () => {
  if (process.platform === "win32") return;
  const f = await fleet({ ignoreReadiness: true, readinessTimeoutMs: 1500 });
  try {
    // A route never switches an explicitly requested mode.
    expect(await f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("wants-stream", { mode: "stream" }) } }))
      .toMatchObject({ status: "blocked", reasons: ["execution_mode:stream"] });
    expect(f.layouts).toHaveLength(0);
    const first = await f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("blocked-one", { mode: "interactive" }) } });
    expect(first).toMatchObject({ status: "uncertain", executionMode: "interactive", reasons: ["worker_readiness_timeout"], intentId: "blocked-one" });
    await f.until(entries => entries.filter(entry => entry.type === "channel").length >= 1);
    // Reconciling the same intent reuses the same launch; nothing relaunches in stream.
    expect(await f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("blocked-one", { mode: "interactive" }) } }))
      .toMatchObject({ status: "uncertain", executionMode: "interactive" });
    await expect(f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("blocked-one", { mode: "stream" }) } }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(f.layouts).toHaveLength(1);
    const { path, record } = await f.receipt();
    expect(record.mode).toBe("interactive");
    const argv = (await f.fixture()).find(entry => entry.type === "argv")!.args as string[];
    expect(argv).not.toContain("--print");
    expect(JSON.parse(await readFile(`${path}.mcp-health`, "utf8")).state).toBe("connected");
    expect(f.wrappers).toHaveLength(1);
    expect(f.wrappers[0]!.exitCode).toBeNull();
  } finally { await f.close(); }
}, 60000);

test("an intent's mode is part of its identity", async () => {
  if (process.platform === "win32") return;
  const f = await fleet({ ignoreReadiness: true, readinessTimeoutMs: 1000 });
  try {
    await f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("fixed", { mode: "interactive" }) } });
    await expect(f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("fixed", { mode: "stream" }) } }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.client.request({ op: "dispatch", input: { action: "assign", intent: f.intent("fixed") } }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.client.request({ op: "dispatch", input: { action: "assign", intent: { ...f.intent("bad"), execution: { mode: "tui" as never } } } }))
      .rejects.toMatchObject({ code: "invalid_input" });
  } finally { await f.close(); }
}, 60000);

test("a route switched after reservation refuses to launch rather than change transport", async () => {
  const provider = herdrDispatchProvider({} as never, {} as never, { id: "r", stateDirectory: "/tmp", profile: "p", socketPath: "/tmp/s",
    herdrPath: "/bin/h", nodePath: "/bin/n", workerPath: "/bin/w", claudePath: "/bin/c", capabilities: [], capacity: null, workerMode: "stream" });
  await expect(provider.start({ token: "00000000-0000-4000-8000-000000000000", taskId: "t", intent: {} as never, executionMode: "interactive" }, new AbortController().signal))
    .rejects.toMatchObject({ code: "execution_mode_changed" });
});

test("route schema: channel plugins require interactive mode", () => {
  const base = { id: "r", stateDirectory: "/tmp", profile: "p", socketPath: "/tmp/s", herdrPath: "/bin/h", nodePath: "/bin/n",
    workerPath: "/bin/w", claudePath: "/bin/c", capabilities: [] };
  const parse = (route: object) => ownerDispatchSchema.parse({ observationMaxAgeMs: 1000, peers: [], herdr: route });
  expect(() => parse({ ...base, channelPlugin: "clankie-worker@clankie" })).toThrow("interactive");
  expect(() => parse({ ...base, workerMode: "interactive", channelPlugin: "no marketplace" })).toThrow();
  expect(parse({ ...base, workerMode: "interactive", channelPlugin: "clankie-worker@clankie" }).herdr).toMatchObject({ workerMode: "interactive" });
  expect(parse(base).herdr).not.toHaveProperty("workerMode");
});

test("approved channel plugin serves the one Swarm MCP; development channel uses the bare server", async () => {
  if (process.platform === "win32") return;
  await mkdir(resolve("dist/test"), { recursive: true });
  const dist = join(await mkdtemp(resolve("dist/test/launcher-")), "coordination");
  await mkdir(dist, { recursive: true });
  for (const name of ["owner-cli", "claude-hook-cli", "client-cli", "mcp-cli"]) await writeFile(join(dist, `${name}.js`), "");
  await build({ entryPoints: ["src/coordination/owner-cli.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(dist, "owner-cli.js") });
  const root = realpathSync(await mkdtemp("/tmp/swarm-channel-launch-"));
  await ownerState(root);
  const common = { stateDirectory: root, nodePath: node(), ownerPath: join(dist, "owner-cli.js"), hookPath: join(dist, "claude-hook-cli.js"),
    identity: { projectRoot: root, fileRoot: root, directory: root, profile: "test" }, skillPath: resolve("skills/swarm-mcp/SKILL.md") };
  const plugin = await prepareClaudeLaunch({ ...common, hostSessionId: crypto.randomUUID(), incarnation: "plugin",
    channel: { plugin: "clankie-worker@clankie" }, settings: { enabledPlugins: { "clankie@clankie": false } } });
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
  expect(at(plugin.arguments, "--channels")).toBe("plugin:clankie-worker@clankie");
  expect(plugin.arguments).not.toContain("--dangerously-load-development-channels");
  expect(JSON.parse(at(plugin.arguments, "--mcp-config")).mcpServers).not.toHaveProperty("swarm");
  const settings = JSON.parse(at(plugin.arguments, "--settings"));
  expect(settings.enabledPlugins).toEqual({ "clankie@clankie": false, "clankie-worker@clankie": true });
  expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
  expect(JSON.parse(plugin.environment.SWARM_WORKER_MCP!)).toEqual([node(), join(dist, "mcp-cli.js")]);
  expect(plugin.environment.SWARM_WORKER_MCP).not.toContain(plugin.environment.SWARM_SESSION_CAPABILITY);
  expect(plugin.environment.SWARM_MCP_CHANNEL).toBe("1");
  const development = await prepareClaudeLaunch({ ...common, hostSessionId: crypto.randomUUID(), incarnation: "dev", channel: {} });
  expect(at(development.arguments, "--dangerously-load-development-channels")).toBe("server:swarm");
  expect(JSON.parse(at(development.arguments, "--mcp-config")).mcpServers.swarm.args).toEqual([join(dist, "mcp-cli.js")]);
  expect(development.environment).not.toHaveProperty("SWARM_WORKER_MCP");
  const stream = await prepareClaudeLaunch({ ...common, hostSessionId: crypto.randomUUID(), incarnation: "stream" });
  expect(stream.arguments.some(arg => arg.includes("channel"))).toBe(false);
  expect(stream.environment).not.toHaveProperty("SWARM_MCP_CHANNEL");
  expect(Object.keys(JSON.parse(at(stream.arguments, "--settings")).hooks)).not.toContain("Stop");
  await expect(prepareClaudeLaunch({ ...common, hostSessionId: crypto.randomUUID(), incarnation: "bad", channel: { plugin: "$(x)" } }))
    .rejects.toThrow("name@marketplace");
});
