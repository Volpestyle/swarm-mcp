import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, readdir, mkdir, cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { ownerState } from "../src/coordination/launcher-state";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { herdrDispatchProvider } from "../src/coordination/herdr-dispatch";
import { ownerDispatchSchema } from "../src/coordination/owner-dispatch";
import { CoordinationClient, localEndpoint } from "../src/coordination/ipc";

test("long Unix state paths retain private, short, distinct endpoints", () => {
  if (process.platform === "win32") return;
  const root = "/tmp/" + "long-state-root/".repeat(12);
  const endpoint = localEndpoint(join(root, "one.db"));
  expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
  expect(endpoint).toBe(localEndpoint(join(root, "one.db")));
  expect(endpoint).not.toBe(localEndpoint(join(root, "two.db")));
});

for (const { lostResponse, started, project = false, mismatch = false, stream = false, harness = "claude-code" as const, complete = false } of [
  { lostResponse: false, started: true },
  { lostResponse: true, started: true },
  { lostResponse: false, started: false },
  { lostResponse: false, started: true, project: true },
  { lostResponse: false, started: true, mismatch: true },
  { lostResponse: false, started: true, stream: true },
  { lostResponse: false, started: true, stream: true, harness: "codex" as const },
  { lostResponse: false, started: true, stream: true, harness: "pi" as const },
  { lostResponse: false, started: true, stream: true, harness: "codex" as const, complete: true },
  { lostResponse: false, started: true, stream: true, harness: "pi" as const, complete: true },
]) test(`Herdr reconciles one token (lost response: ${lostResponse}, receipt: ${started}, project: ${project}, mismatch: ${mismatch}, stream: ${stream}, harness: ${harness}, complete: ${complete})`, async () => {
  if (process.platform === "win32") return; // Herdr's local Unix transport.
  await mkdir(resolve("dist/test"), { recursive: true });
  const packageRoot = await mkdtemp(resolve("dist/test/herdr-"));
  const dist = join(packageRoot, "dist/coordination");
  await cp("skills/swarm-mcp", join(packageRoot, "skills/swarm-mcp"), { recursive: true });
  await build({ entryPoints: ["owner-cli", "claude-hook-cli", "client-cli", "mcp-cli", "herdr-worker-cli"].map(name => `src/coordination/${name}.ts`),
    bundle: true, platform: "node", format: "esm", packages: "external", outdir: dist });
  if (mismatch) await build({ entryPoints: ["src/coordination/mcp-cli.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(dist, "mismatched-mcp.js"),
    define: { SWARM_BUILD: JSON.stringify({ revision: "wrong", sourceDigest: "wrong", packageVersion: "test", sdkVersion: "test" }) } });
  const root = realpathSync(await mkdtemp("/tmp/swarm-herdr-test-"));
  let selected = root;
  const repository = join(root, "project");
  if (project) {
    await mkdir(repository);
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { stdio: "pipe" });
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
    selected = join(root, "isolated");
    git("worktree", "add", "--detach", selected);
  }
  const owner = await ownerState(root);
  const herdr = join(root, "herdr");
  const log = join(root, "calls.jsonl");
  // The CLI only creates/inspects topology. Worker launch uses the native
  // layout API, even if its one-shot response is lost after process creation.
  await writeFile(herdr, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'workspace') console.log(JSON.stringify({result:{root_pane:{pane_id:'w1:p1'},tab:{tab_id:'w1:t1'}}}));
else if (args[0] === 'pane' && args[1] === 'get') console.log(JSON.stringify({result:{pane_id:args[2]}}));
else process.exit(2);
`, { mode: 0o700 });
  const wrapperProcesses: ReturnType<typeof spawn>[] = [];
  const fakeClaude = join(root, "claude-fixture");
  if (stream) await writeFile(fakeClaude, "#!/usr/bin/env node\n" + await readFile("test/fixtures/stream-worker-harness.cjs", "utf8"), { mode: 0o700 });
  const layouts: any[] = [];
  const runtime = () => createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      layouts.push(request);
      const target = request.params.root.command[2];
      const record = JSON.parse(await readFile(target, "utf8"));
      if (stream) {
        const child = spawn(Bun.which("node")!, [join(dist, "herdr-worker-cli.js"), target], { env: { ...process.env, HERDR_PANE_ID: "w1:p2", SWARM_FIXTURE_COMPLETE: complete ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.resume(); child.stderr.resume(); wrapperProcesses.push(child);
      } else if (started) {
        record.started = true;
        record.paneId = "w1:p2";
        await writeFile(target, JSON.stringify(record));
      }
      if (mismatch && started) {
        const child = spawn(Bun.which("node")!, [join(dist, "mismatched-mcp.js")], { env: { ...process.env, ...record.environment }, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.resume(); child.stderr.resume();
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      if (lostResponse) socket.destroy();
      else {
        const response = JSON.stringify({ id: request.id, result: { layout: { root: { pane_id: "w1:p2" } } } }) + "\n";
        socket.write(response.slice(0, 10));
        socket.end(response.slice(10));
      }
    });
  });
  const server = runtime(), secondServer = runtime();
  await new Promise<void>(resolve => server.listen(join(root, "herdr.sock"), resolve));
  await new Promise<void>(resolve => secondServer.listen(join(root, "second.sock"), resolve));
  const firstRoute = { id: "herdr", stateDirectory: root, readinessTimeoutMs: stream ? 10000 : mismatch ? 5000 : 1000,
    profile: "test", socketPath: join(root, "herdr.sock"), herdrPath: herdr, claudePath: stream ? fakeClaude : Bun.which("node")!,
    ...(harness === "claude-code" ? {} : { harness, harnessPath: fakeClaude }),
    nodePath: Bun.which("node")!, workerPath: join(dist, "herdr-worker-cli.js"), capabilities: ["code"], capacity: 1,
    ...(project ? { workspaces: [{ kind: "repository" as const, path: join(repository, ".git") }] } : {}),
    mcpServers: { connected_tools: { command: "clankie", args: ["mcp", "--swarm"], env: { CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310" } } } };
  const secondRoute = { ...firstRoute, id: "second", socketPath: join(root, "second.sock"), capabilities: ["research"] };
  const dispatch = { maximum: 2, observationMaxAgeMs: 60000, peers: [], herdr: [firstRoute, secondRoute] };
  expect(ownerDispatchSchema.parse({ ...dispatch, herdr: firstRoute }).herdr).toEqual({ ...firstRoute, enabled: true });
  expect(() => ownerDispatchSchema.parse({ ...dispatch, herdr: [firstRoute, firstRoute] })).toThrow();
  await writeFile(owner.configPath, JSON.stringify({ version: 1, ...owner, dispatch }));
  const enrolled = await enrollRuntime({ stateDirectory: root, nodePath: Bun.which("node")!, ownerPath: join(dist, "owner-cli.js"),
    host: "pi", hostSessionId: "leader", incarnation: "launch", identity: { projectRoot: root, fileRoot: root, directory: root, profile: "test" } });
  const client = await CoordinationClient.connect(enrolled.environment.SWARM_COORDINATOR_ENDPOINT, enrolled.environment.SWARM_SESSION_CAPABILITY);
  try {
    const intent = { intentId: "one-task", title: "Work", capabilities: ["code"], durable: true,
      contract: { objective: "Work", worktree: selected, acceptanceCriteria: ["Done"], expectedArtifacts: [], constraints: [] } };
    // The owner is already running: a disabled route is read before every dispatch.
    await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch: { ...dispatch, herdr: [
      { ...firstRoute, enabled: false }, secondRoute,
    ] } }));
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "blocked" });
    expect((await readdir(root)).filter(name => /^herdr-.*[.]json$/.test(name))).toHaveLength(0);
    await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch }));
    const rejected = await client.request({ op: "dispatch", input: { action: "assign", intent: {
      ...intent, intentId: "unapproved", contract: { ...intent.contract, worktree: join(root, "unapproved") },
    } } });
    expect(rejected).toMatchObject({ status: "blocked", requestedWorktree: join(root, "unapproved"), reasons: ["capability:code", "worktree"],
      routes: expect.arrayContaining([expect.objectContaining({ routeId: "herdr", allowedWorktrees: expect.arrayContaining([root, selected]), reasons: ["worktree"] })]) });
    expect((await readdir(root)).filter(name => /^herdr-.*[.]json$/.test(name))).toHaveLength(0);
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent: { ...intent, intentId: "unsupported-host", host: "missing-harness" } } }))
      .toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["host"]) });
    expect((await readdir(root)).filter(name => /^herdr-.*[.]json$/.test(name))).toHaveLength(0);
    const dispatchAt = Date.now();
    const first = await client.request({ op: "dispatch", input: { action: "assign", intent } });
    if (stream) {
      expect(first).toMatchObject({ status: "bound", harness });
      const launch = (await readdir(root)).find(name => /^herdr-.*[.]json$/.test(name))!;
      const healthPath = `${join(root, launch)}.mcp-health`;
      const health = JSON.parse(await readFile(healthPath, "utf8"));
      expect(health.state).toBe("ready");
      if (complete) {
        const taskId = (first as any).taskId;
        const waited = await client.request({ op: "task_wait", taskId, timeoutMs: 5000 });
        expect(waited).toMatchObject({ waitState: "terminal", task: { status: "completed" } });
        expect(await client.request({ op: "dispatch", input: { action: "cancel", intentId: intent.intentId } })).toMatchObject({ status: "released", harness });
        const db = new Database(owner.databasePath, { readonly: true });
        try {
          expect(db.prepare("SELECT harness FROM dispatch_intents WHERE intent_id=?").get(intent.intentId)).toEqual({ harness });
          expect(db.prepare("SELECT count(*) n FROM inbox_deliveries d JOIN inbox_messages m ON m.id=d.message_id WHERE m.kind='task.assigned' AND d.state='acknowledged'").get()).toEqual({ n: 1 });
        } finally { db.close(); }
        return;
      }
      // Kill only the real owned test MCP; the wrapper and harness survive.
      process.kill(health.pid, "SIGKILL");
      const deadline = Date.now() + 5000;
      let notified = false;
      while (Date.now() < deadline) {
        const inbox = await client.request({ op: "command", command: { id: `health-fetch-${Date.now()}`, type: "inbox.fetch", payload: { consumer: "lead" } } });
        if (JSON.stringify(inbox).includes("blocked:mcp_disconnected")) { notified = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(notified).toBe(true);
      expect(wrapperProcesses[0]!.exitCode).toBeNull();
      expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "uncertain", reasons: ["worker_mcp_unavailable"] });
      expect(layouts).toHaveLength(1);
      // An unavailable MCP cannot acknowledge cancellation. The owning wrapper
      // must terminate the process group before the provider releases capacity.
      expect(await client.request({ op: "dispatch", input: { action: "cancel", intentId: intent.intentId } }))
        .toMatchObject({ status: "released" });
      const stopped = JSON.parse(await readFile(`${join(root, launch)}.stopped`, "utf8"));
      expect(stopped.token).toBe(health.token);
      const physical = JSON.parse(await readFile(join(root, launch), "utf8"));
      expect(physical.harness).toBe(harness);
      expect((await client.request({ op: "task_detail", taskId: (first as any).taskId }) as any).status).toBe("cancelled");
      const db = new Database(owner.databasePath, { readonly: true });
      try {
        expect(db.prepare("SELECT count(*) n FROM inbox_deliveries d JOIN inbox_messages m ON m.id=d.message_id WHERE m.kind='task.cancel_requested' AND d.state='expired' AND d.last_error='dispatch_released'").get())
          .toEqual({ n: 1 });
      } finally { db.close(); }
      return;
    }
    // Neither CLI acceptance nor a receipt alone proves a running worker.
    expect(first).toMatchObject({ status: "uncertain" });
    if (mismatch) { expect(first).toMatchObject({ reasons: ["coordinator_version_mismatch"], intentId: intent.intentId }); expect(Date.now() - dispatchAt).toBeLessThan(5000); }
    const launch = (await readdir(root)).find(name => /^herdr-.*[.]json$/.test(name))!;
    const worker = JSON.parse(await readFile(join(root, launch), "utf8"));
    expect(worker.environment.SWARM_SCOPE).toBe(enrolled.scope);
    expect(worker.cwd).toBe(selected);
    const db = new Database(owner.databasePath, { readonly: true });
    expect(db.prepare("SELECT worktree_root,repository_root FROM sessions WHERE id=?").get(worker.worker.sessionId))
      .toEqual({ worktree_root: selected, repository_root: project ? join(repository, ".git") : root });
    db.close();
    const mcp = JSON.parse(worker.args[worker.args.indexOf("--mcp-config") + 1]);
    expect(mcp.mcpServers.connected_tools).toEqual({ command: "clankie", args: ["mcp", "--swarm"], env: { CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310" } });
    expect(mcp.mcpServers.swarm.args[0]).toBe(join(dist, "mcp-cli.js"));
    expect(JSON.stringify(mcp)).not.toContain(worker.environment.SWARM_SESSION_CAPABILITY);
    if (!started) {
      expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "uncertain" });
      worker.started = true;
      worker.paneId = "w1:p2";
      await writeFile(join(root, launch), JSON.stringify(worker));
    }
    if (mismatch) await rm(`${join(root, launch)}.mcp-health`);
    const connected = await CoordinationClient.connect(worker.environment.SWARM_COORDINATOR_ENDPOINT, worker.environment.SWARM_SESSION_CAPABILITY);
    await connected.request({ op: "command", command: { id: "online", type: "session.observe", payload: { runtime: "available" } } });
    // Availability alone must never authorize coordinator-side claiming.
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "uncertain" });
    await connected.request({ op: "command", command: { id: "ready", type: "dispatch.workerReady", payload: {
      intentId: intent.intentId, token: worker.token, externalId: worker.paneId,
    } } });
    connected.close();
    if (project) await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch: { ...dispatch,
      herdr: [{ ...firstRoute, workspaces: [{ kind: "repository", path: join(root, "removed-repo") }, { kind: "directory", path: join(root, "removed-dir") }] }, secondRoute],
    } }));
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "bound" });
    await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch }));
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(args => args[0] === "workspace")).toHaveLength(1);
    expect(calls.some(args => args[1] === "run")).toBe(false);
    expect(calls.filter(args => args[1] === "get").every(args => args[2] === "w1:p2")).toBe(true);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ method: "layout.apply", params: {
      tab_id: "w1:t1", focus: false, root: { type: "pane", cwd: selected,
        command: [Bun.which("node")!, join(dist, "herdr-worker-cli.js"), join(root, launch)] },
    } });
    expect(calls[0]).toContain("--no-focus");
    // The second runtime may reuse the same pane IDs. Route identity distinguishes them.
    if (project) await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch: { ...dispatch,
      herdr: [firstRoute, { ...secondRoute, workspaces: [{ kind: "directory", path: join(root, "removed-dir") }, { kind: "repository", path: join(root, "removed-repo") }] }],
    } }));
    const secondIntent = { ...intent, intentId: "second-task", capabilities: ["research"], contract: { ...intent.contract, worktree: root } };
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent: secondIntent } })).toMatchObject({ status: "uncertain", routeId: "second" });
    const secondLaunch = (await readdir(root)).find(name => /^herdr-.*[.]json$/.test(name) && name !== launch)!;
    const secondWorker = JSON.parse(await readFile(join(root, secondLaunch), "utf8"));
    if (!started) {
      secondWorker.started = true;
      secondWorker.paneId = "w1:p2";
      await writeFile(join(root, secondLaunch), JSON.stringify(secondWorker));
    }
    if (mismatch) await rm(`${join(root, secondLaunch)}.mcp-health`);
    const secondConnection = await CoordinationClient.connect(secondWorker.environment.SWARM_COORDINATOR_ENDPOINT, secondWorker.environment.SWARM_SESSION_CAPABILITY);
    await secondConnection.request({ op: "command", command: { id: "online", type: "session.observe", payload: { runtime: "available" } } });
    await secondConnection.request({ op: "command", command: { id: "ready", type: "dispatch.workerReady", payload: {
      intentId: secondIntent.intentId, token: secondWorker.token, externalId: secondWorker.paneId,
    } } });
    secondConnection.close();
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent: secondIntent } })).toMatchObject({ status: "bound" });
    expect(layouts).toHaveLength(2);
    await writeFile(owner.configPath, JSON.stringify({ ...owner, launcherSecret: "different-secret-that-must-not-replace-the-owner", dispatch }));
    await expect(client.request({ op: "dispatch", input: { action: "assign", intent } })).rejects.toThrow("Coordinator operation failed");
    await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch }));
    expect(secondWorker.routeFingerprint).not.toBe(worker.routeFingerprint);
    // Recovery rejects retargeting before running any command at the wrong socket.
    const retargeted = herdrDispatchProvider({} as never, {} as never, { ...firstRoute, socketPath: secondRoute.socketPath });
    await expect(retargeted.find(worker.token, new AbortController().signal)).rejects.toThrow(/runtime identity/);
    await expect(retargeted.stop!(worker.token, new AbortController().signal)).rejects.toThrow(/runtime identity/);
    expect((await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(args => args[0] === "workspace")).toHaveLength(2);
  } finally { for (const child of wrapperProcesses) { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } } client.close(); enrolled.launchedOwner?.kill(); server.close(); secondServer.close(); }
}, 30000);
