import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, readdir, mkdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
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

for (const { lostResponse, started } of [
  { lostResponse: false, started: true },
  { lostResponse: true, started: true },
  { lostResponse: false, started: false },
]) test(`Herdr reconciles one token (lost response: ${lostResponse}, receipt: ${started})`, async () => {
  if (process.platform === "win32") return; // Herdr's local Unix transport.
  await mkdir(resolve("dist/test"), { recursive: true });
  const packageRoot = await mkdtemp(resolve("dist/test/herdr-"));
  const dist = join(packageRoot, "dist/coordination");
  await cp("skills/swarm-mcp", join(packageRoot, "skills/swarm-mcp"), { recursive: true });
  await build({ entryPoints: ["owner-cli", "claude-hook-cli", "client-cli", "mcp-cli", "herdr-worker-cli"].map(name => `src/coordination/${name}.ts`),
    bundle: true, platform: "node", format: "esm", packages: "external", outdir: dist });
  const root = realpathSync(await mkdtemp("/tmp/swarm-herdr-test-"));
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
      if (started) {
        record.started = true;
        record.paneId = "w1:p2";
        await writeFile(target, JSON.stringify(record));
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
  const firstRoute = { id: "herdr", stateDirectory: root,
    profile: "test", socketPath: join(root, "herdr.sock"), herdrPath: herdr, claudePath: Bun.which("node")!,
    nodePath: Bun.which("node")!, workerPath: join(dist, "herdr-worker-cli.js"), capabilities: ["code"], capacity: 1,
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
      contract: { objective: "Work", worktree: root, acceptanceCriteria: ["Done"], expectedArtifacts: [], constraints: [] } };
    // The owner is already running: a disabled route is read before every dispatch.
    await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch: { ...dispatch, herdr: [
      { ...firstRoute, enabled: false }, secondRoute,
    ] } }));
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "blocked" });
    expect((await readdir(root)).filter(name => /^herdr-.*[.]json$/.test(name))).toHaveLength(0);
    await writeFile(owner.configPath, JSON.stringify({ ...owner, dispatch }));
    const first = await client.request({ op: "dispatch", input: { action: "assign", intent } });
    // Neither CLI acceptance nor a receipt alone proves a running worker.
    expect(first).toMatchObject({ status: "uncertain" });
    const launch = (await readdir(root)).find(name => /^herdr-.*[.]json$/.test(name))!;
    const worker = JSON.parse(await readFile(join(root, launch), "utf8"));
    expect(worker.environment.SWARM_SCOPE).toBe(enrolled.scope);
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
    const connected = await CoordinationClient.connect(worker.environment.SWARM_COORDINATOR_ENDPOINT, worker.environment.SWARM_SESSION_CAPABILITY);
    await connected.request({ op: "command", command: { id: "online", type: "session.observe", payload: { runtime: "available" } } });
    connected.close();
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent } })).toMatchObject({ status: "bound" });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(args => args[0] === "workspace")).toHaveLength(1);
    expect(calls.some(args => args[1] === "run")).toBe(false);
    expect(calls.filter(args => args[1] === "get").every(args => args[2] === "w1:p2")).toBe(true);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ method: "layout.apply", params: {
      tab_id: "w1:t1", focus: false, root: { type: "pane", cwd: root,
        command: [Bun.which("node")!, join(dist, "herdr-worker-cli.js"), join(root, launch)] },
    } });
    expect(calls[0]).toContain("--no-focus");
    // The second runtime may reuse the same pane IDs. Route identity distinguishes them.
    const secondIntent = { ...intent, intentId: "second-task", capabilities: ["research"] };
    expect(await client.request({ op: "dispatch", input: { action: "assign", intent: secondIntent } })).toMatchObject({ status: "uncertain", routeId: "second" });
    const secondLaunch = (await readdir(root)).find(name => /^herdr-.*[.]json$/.test(name) && name !== launch)!;
    const secondWorker = JSON.parse(await readFile(join(root, secondLaunch), "utf8"));
    if (!started) {
      secondWorker.started = true;
      secondWorker.paneId = "w1:p2";
      await writeFile(join(root, secondLaunch), JSON.stringify(secondWorker));
    }
    const secondConnection = await CoordinationClient.connect(secondWorker.environment.SWARM_COORDINATOR_ENDPOINT, secondWorker.environment.SWARM_SESSION_CAPABILITY);
    await secondConnection.request({ op: "command", command: { id: "online", type: "session.observe", payload: { runtime: "available" } } });
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
  } finally { client.close(); enrolled.launchedOwner?.kill(); server.close(); secondServer.close(); }
}, 30000);
