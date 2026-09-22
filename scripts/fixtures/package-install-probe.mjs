import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";

const packageRoot = resolve(process.argv[2]), stateRoot = resolve(process.argv[3]);
assert.equal(existsSync(join(packageRoot, "src")), false);
assert.equal(existsSync(join(packageRoot, "node_modules/esbuild")), false);
const { prepareClaudeLaunch } = await import(pathToFileURL(join(packageRoot, "dist/coordination/claude-launcher.js")));
const worktree = join(stateRoot, "worktree"); mkdirSync(worktree);
const prepared = await prepareClaudeLaunch({ stateDirectory: join(stateRoot, "private"), nodePath: process.execPath,
  ownerPath: join(packageRoot, "dist/coordination/owner-cli.js"), hookPath: join(packageRoot, "dist/coordination/claude-hook-cli.js"),
  skillPath: join(packageRoot, "skills/swarm-mcp/SKILL.md"),
  identity: { projectRoot: worktree, profile: "isolated-install", directory: worktree, fileRoot: worktree, allowedRoots: [worktree] },
  hostSessionId: randomUUID(), incarnation: randomUUID() });
let mcp;
try {
  const env = { ...process.env, ...prepared.environment };
  const doctor = JSON.parse(execFileSync(process.execPath, [join(packageRoot, "dist/coordination/client-cli.js"), "doctor"], { env, encoding: "utf8", windowsHide: true }));
  assert.equal(doctor.configuredSkill.status, "file_verified");
  assert.equal(doctor.compatibility.build.sourceDigest, doctor.clientCompatibility.build.sourceDigest);
  assert.equal(doctor.compatibility.build.sdkVersion, "2.0.0");
  mcp = spawn(process.execPath, [join(packageRoot, "dist/coordination/mcp-cli.js")], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = ""; mcp.stderr.on("data", bytes => { stderr += bytes; });
  const pending = new Map(); let id = 0;
  const lines = createInterface({ input: mcp.stdout });
  lines.on("line", line => { const value = JSON.parse(line); const resolve = pending.get(value.id); if (resolve) { pending.delete(value.id); resolve(value); } });
  const request = async (method, params) => {
    const next = ++id;
    let timer;
    const result = await Promise.race([
      new Promise(resolve => { pending.set(next, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Packed MCP timed out: ${stderr}`)), 10000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.result;
  };
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "clean-package-probe", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await request("tools/list", {}); assert.equal(tools.tools.length, 9);
  const call = async (name, args) => {
    const result = await request("tools/call", { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content)); return result.structuredContent.data;
  };
  const state = await call("swarm_sync", {}); assert.equal(state.actor, prepared.actor);
  await call("swarm_send", { commandId: "packed-send", recipient: prepared.actor, kind: "question", body: "Packed runtime check", threadId: "packed-thread" });
  const lease = (await call("swarm_inbox", { commandId: "packed-fetch", action: "fetch", consumer: "packed" })).value.deliveries[0];
  await call("swarm_inbox", { commandId: "packed-ack", action: "ack", messageId: lease.message.id, leaseToken: lease.leaseToken });
  const final = JSON.parse(execFileSync(process.execPath, [join(packageRoot, "dist/coordination/client-cli.js"), "doctor"], { env, encoding: "utf8", windowsHide: true }));
  assert.equal(final.summary.acknowledged, 1);
  mcp.stdin.end(); await once(mcp, "exit"); lines.close();
  assert.equal(stderr, "");
  console.log(JSON.stringify({ ok: true, sourcePresent: false, devDependenciesPresent: false, ownerLaunched: Boolean(prepared.launchedOwner),
    configuredSkill: "file_verified", tools: tools.tools.length, protocol: initialized.protocolVersion, acknowledged: 1,
    compatibility: doctor.compatibility,
    installed: Object.fromEntries(["@modelcontextprotocol/server", "@opencode-ai/sdk", "better-sqlite3", "zod"].map(name =>
      [name, JSON.parse(readFileSync(join(packageRoot, "node_modules", name, "package.json"), "utf8")).version])) }));
} finally {
  if (mcp && mcp.exitCode === null) { const exited = once(mcp, "exit"); mcp.kill(); await exited; }
  if (prepared.launchedOwner && prepared.launchedOwner.exitCode === null) {
    prepared.launchedOwner.ref(); const exited = once(prepared.launchedOwner, "exit"); prepared.launchedOwner.kill(); await exited;
  }
}
