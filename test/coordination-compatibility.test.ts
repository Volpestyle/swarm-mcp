import { expect, test } from "bun:test";
import { build } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { assertCompatibleOwner, compatibility, inspectSkill } from "../src/coordination/compatibility";
import { CoordinationClient } from "../src/coordination/ipc";
import { readOwnerConfig } from "../src/coordination/owner-config";

test("MCP entrypoint explains enrollment and refuses retired subcommands", async () => {
  for (const [args, expectedCode, message] of [
    [["--help"], 0, "trusted runtime launcher"],
    [["init"], 1, "no subcommands"],
    [[], 1, "endpoint and session capability are required"],
  ] as const) {
    const child = Bun.spawn({
      cmd: [process.execPath, resolve("src/coordination/mcp-cli.ts"), ...args],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SWARM_"))),
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(expectedCode);
    expect(stdout + stderr).toContain(message);
  }
});

test("contract and configured skill validation distinguish stale, missing and unobserved", () => {
  expect(compatibility.serverVersion).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
  expect(() => assertCompatibleOwner(null)).toThrow("Owner API/schema/skill contract differs");
  expect(() => assertCompatibleOwner({ ...compatibility, apiVersion: 999 })).toThrow();
  expect(inspectSkill().status).toBe("not_configured");
  expect(inspectSkill(resolve("skills/swarm-mcp/SKILL.md")).status).toBe("file_verified");
  const root = mkdtempSync(join(tmpdir(), "swarm-skill-")), path = join(root, "SKILL.md");
  writeFileSync(path, "---\nname: swarm-mcp\n---\nOld register workflow\ncoordination-contract: swarm-coordination/1\n");
  expect(() => inspectSkill(path)).toThrow("Configured skill lacks");
  expect(() => inspectSkill("relative/SKILL.md")).toThrow("absolute");
  expect(() => inspectSkill(join(root, "missing.md"))).toThrow("cannot be read");
  const config = join(root, "owner.json");
  writeFileSync(config, JSON.stringify({ version: 99, databasePath: join(root, "db"), launcherSecret: "x".repeat(32) }));
  const before = readFileSync(config);
  expect(() => readOwnerConfig(config)).toThrow("Unsupported owner config version");
  expect(readFileSync(config)).toEqual(before);
});

test("different built clients reject a live owner without enrolling or replacing it", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const out = mkdtempSync(resolve("dist/test/compatibility-"));
  const buildStamp = (sourceDigest: string) => JSON.stringify({ sourceDigest, revision: "fixture", packageVersion: "fixture", sdkVersion: "2.0.0" });
  const ownerPath = join(out, "owner.mjs"), launcherPath = join(out, "launcher.mjs"), mcpPath = join(out, "mcp.mjs");
  for (const [entry, outfile, stamp] of [
    ["src/coordination/owner-cli.ts", ownerPath, "old-build"],
    ["test/fixtures/compatibility-launcher.ts", launcherPath, "new-build"],
    ["src/coordination/mcp-cli.ts", mcpPath, "new-build"],
  ]) await build({ entryPoints: [entry!], outfile, bundle: true, platform: "node", format: "esm",
    packages: "external", target: "node22", define: { SWARM_BUILD: buildStamp(stamp!) } });
  const root = mkdtempSync(join(tmpdir(), "swarm-compatible-")), config = join(root, "owner.json"), dbPath = join(root, "db");
  const secret = randomBytes(32).toString("hex");
  writeFileSync(config, JSON.stringify({ version: 99, databasePath: dbPath, launcherSecret: secret }));
  const badOwner = Bun.spawn({ cmd: ["node", ownerPath, config], stdout: "pipe", stderr: "pipe" });
  const [badCode, badError] = await Promise.all([badOwner.exited, new Response(badOwner.stderr).text()]);
  expect(badCode).toBe(1); expect(badError).toContain("Unsupported owner config version");
  expect(existsSync(dbPath)).toBe(false);
  writeFileSync(config, JSON.stringify({ version: 1, databasePath: dbPath, launcherSecret: secret }));
  const owner = Bun.spawn({ cmd: ["node", ownerPath, config], stdout: "pipe", stderr: "pipe" });
  const clients: CoordinationClient[] = [];
  try {
    const reader = owner.stdout.getReader(); const ready = await reader.read(); reader.releaseLock();
    if (!ready.value) throw new Error(await new Response(owner.stderr).text());
    const { endpoint } = JSON.parse(new TextDecoder().decode(ready.value));
    const launcher = await CoordinationClient.connect(endpoint, secret); clients.push(launcher);
    expect((await launcher.request({ op: "compatibility" }) as any).build.sourceDigest).toBe("old-build");
    const invalid = await CoordinationClient.connect(endpoint, "not-authorized"); clients.push(invalid);
    await expect(invalid.request({ op: "compatibility" })).rejects.toThrow();
    const mismatch = Bun.spawn({ cmd: ["node", launcherPath, config, ownerPath], stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([mismatch.exited, new Response(mismatch.stderr).text()]);
    expect(code).toBe(1); expect(stderr).toContain("coordinator_build_mismatch");
    const db = new Database(dbPath, { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 }); } finally { db.close(); }
    const session: any = await launcher.request({ op: "enroll", input: { scope: "fixture", agentId: "worker", requestId: "one", resumeToken: randomBytes(32).toString("hex") } });
    const mcp = Bun.spawn({ cmd: ["node", mcpPath], env: { ...process.env, SWARM_COORDINATOR_ENDPOINT: endpoint, SWARM_SESSION_CAPABILITY: session.capability }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [mcpCode, mcpError] = await Promise.all([mcp.exited, new Response(mcp.stderr).text()]);
    expect(mcpCode).toBe(1); expect(mcpError).toContain("different or unidentified build");
    expect(owner.exitCode).toBeNull();
    expect((await launcher.request({ op: "compatibility" }) as any).build.sourceDigest).toBe("old-build");
  } finally { for (const client of clients) client.close(); owner.kill(); await owner.exited; }
}, 10000);
