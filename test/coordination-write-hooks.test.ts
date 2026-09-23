import { afterAll, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../src/coordination/ipc";
let owner: ReturnType<typeof Bun.spawn>,
  main: string,
  peer: string,
  clientScript: string;
let integrationCommit: string;
let credentials: {
  endpoint: string;
  alice: string;
  bob: string;
  carol: string;
};
const python = Bun.which("python")!;
const pre = resolve("integrations/claude-code/hooks/pre_tool_use.py"),
  post = resolve("integrations/claude-code/hooks/post_tool_use.py");
const clients: CoordinationClient[] = [];
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-hook-integration-"));
  main = join(root, "main");
  peer = join(root, "peer");
  mkdirSync(main);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", main, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(main, "base.txt"), "base\n");
  git("add", "base.txt");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  git("worktree", "add", "-b", "peer", peer);
  writeFileSync(join(main, "base.txt"), "integrated change\n");
  git("add", "base.txt");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "integration candidate",
  );
  integrationCommit = git("rev-parse", "HEAD").toString().trim();
  mkdirSync(resolve("dist/test"), { recursive: true });
  const out = mkdtempSync(resolve("dist/test/hooks-"));
  clientScript = join(out, "client.mjs");
  const ownerScript = join(out, "owner.mjs");
  await Promise.all([
    build({
      entryPoints: ["src/coordination/client-cli.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      outfile: clientScript,
    }),
    build({
      entryPoints: ["test/fixtures/reservation-service.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      outfile: ownerScript,
    }),
  ]);
  owner = Bun.spawn({
    cmd: [Bun.which("node")!, ownerScript, join(root, "db.sqlite"), main, peer],
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (owner.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  if (!value)
    throw new Error(await new Response(owner.stderr as ReadableStream).text());
  credentials = JSON.parse(new TextDecoder().decode(value));
}, 30000);
afterAll(async () => {
  for (const c of clients) c.close();
  if (owner) {
    owner.kill();
    await owner.exited;
  }
});
function env(actor: "alice" | "bob" | "carol") {
  return {
    ...process.env,
    SWARM_COORDINATOR_CLIENT: JSON.stringify([
      Bun.which("node")!,
      clientScript,
    ]),
    SWARM_COORDINATOR_ENDPOINT: credentials.endpoint,
    SWARM_SESSION_CAPABILITY: credentials[actor],
    SWARM_MCP_DIRECTORY: actor === "carol" ? peer : main,
  };
}
async function run(
  argv: string[],
  actor: "alice" | "bob" | "carol",
  input?: string,
  overrides: Record<string, string> = {},
) {
  const proc = Bun.spawn({
    cmd: argv,
    env: { ...env(actor), ...overrides },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
async function connect(actor: "alice" | "bob" | "carol") {
  const client = await CoordinationClient.connect(
    credentials.endpoint,
    credentials[actor],
  );
  clients.push(client);
  return client;
}
test("real pre/post hooks serialize competing subprocess writes and release the winning grant", async () => {
  const path = join(main, "contended.txt"),
    payload = (actor: string, id: string) => ({
      session_id: actor,
      tool_use_id: id,
      tool_name: "Write",
      tool_input: { file_path: path },
    });
  const results = await Promise.all(
    (["alice", "bob"] as const).map((actor) =>
      run(
        [
          python,
          resolve("test/fixtures/hooked-write.py"),
          pre,
          JSON.stringify(payload(actor, `first-${actor}`)),
          path,
          actor,
        ],
        actor,
      ),
    ),
  );
  const parsed = results.map((r) => {
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout);
  });
  expect(parsed.filter((r) => r.allowed)).toHaveLength(1);
  const winner = parsed[0].allowed ? "alice" : "bob",
    loser = winner === "alice" ? "bob" : "alice";
  expect(readFileSync(path, "utf8")).toBe(winner);
  const release = await run(
    [python, post],
    winner,
    JSON.stringify(payload(winner, `first-${winner}`)),
  );
  expect(release.code).toBe(0);
  expect(release.stderr).toBe("");
  const retry = await run(
    [
      python,
      resolve("test/fixtures/hooked-write.py"),
      pre,
      JSON.stringify(payload(loser, "retry")),
      path,
      loser,
    ],
    loser,
  );
  expect(JSON.parse(retry.stdout).allowed).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(loser);
  await run([python, post], loser, JSON.stringify(payload(loser, "retry")));
}, 30000);
test("integration critical section blocks another worktree's subprocess until release", async () => {
  const alice = await connect("alice");
  const grant = (await alice.request({
    op: "command",
    command: {
      id: "integration",
      type: "reservation.acquire",
      payload: { kind: "integration", reason: "merge owner" },
    },
  })) as { value: { grants: Array<{ id: string; fence: number }> } };
  const cmd = [
    python,
    resolve("integrations/_shared/leased_command.py"),
    "--kind",
    "integration",
    "--reason",
    "integrate peer",
    "--",
    "git",
    "-C",
    peer,
    "merge",
    "--ff-only",
    integrationCommit,
  ];
  const denied = await run(cmd, "carol");
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain("alice");
  expect(readFileSync(join(peer, "base.txt"), "utf8")).toBe("base\n");
  await alice.request({
    op: "command",
    command: {
      id: "release-integration",
      type: "reservation.release",
      payload: {
        grants: grant.value.grants.map((g) => ({ id: g.id, fence: g.fence })),
      },
    },
  });
  const allowed = await run(cmd, "carol");
  expect(allowed.code).toBe(0);
  expect(readFileSync(join(peer, "base.txt"), "utf8")).toBe(
    "integrated change\n",
  );
}, 30000);
test("opted-in hooks deny unknown path payloads and unreachable coordinators", async () => {
  const malformed = await run(
    [python, pre],
    "alice",
    JSON.stringify({
      session_id: "alice",
      tool_use_id: "malformed",
      tool_name: "Write",
      tool_input: {},
    }),
  );
  expect(
    JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision,
  ).toBe("deny");
  const unknown = await run(
    [python, pre],
    "alice",
    JSON.stringify({
      session_id: "alice",
      tool_name: "Write",
      tool_input: { file_path: join(main, "unidentified.txt") },
    }),
  );
  expect(JSON.parse(unknown.stdout).hookSpecificOutput.permissionDecision).toBe(
    "deny",
  );
  const unavailable = await run(
    [python, pre],
    "alice",
    JSON.stringify({
      session_id: "alice",
      tool_use_id: "unavailable",
      tool_name: "Write",
      tool_input: { file_path: join(main, "unavailable.txt") },
    }),
    { SWARM_COORDINATOR_ENDPOINT: credentials.endpoint + "-missing" },
  );
  expect(
    JSON.parse(unavailable.stdout).hookSpecificOutput.permissionDecision,
  ).toBe("deny");
}, 30000);

test("Codex rename hook reserves source and destination atomically", async () => {
  const alice = await connect("alice"),
    bob = await connect("bob");
  const codexPre = resolve(
      "integrations/codex/plugins/swarm/hooks/pre_tool_use.py",
    ),
    codexPost = resolve(
      "integrations/codex/plugins/swarm/hooks/post_tool_use.py",
    );
  const held = (await alice.request({
    op: "command",
    command: {
      id: "hold-rename-target",
      type: "reservation.acquire",
      payload: { kind: "file", paths: ["renamed.txt"], reason: "target edit" },
    },
  })) as { value: { grants: Array<{ id: string; fence: number }> } };
  const payload = {
    session_id: "bob",
    tool_use_id: "rename",
    tool_name: "apply_patch",
    tool_input:
      "*** Begin Patch\n*** Update File: original.txt\n*** Move to: renamed.txt\n@@\n-old\n+new\n*** End Patch",
  };
  const denied = await run([python, codexPre], "bob", JSON.stringify(payload));
  expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe(
    "deny",
  );
  const rows = (await bob.request({ op: "reservations" })) as Array<{
    actor: string;
  }>;
  expect(rows.filter((r) => r.actor === "bob")).toHaveLength(0);
  await alice.request({
    op: "command",
    command: {
      id: "release-rename-target",
      type: "reservation.release",
      payload: {
        grants: held.value.grants.map((g) => ({ id: g.id, fence: g.fence })),
      },
    },
  });
  const allowedPayload = { ...payload, tool_use_id: "rename-retry" };
  const allowed = await run(
    [python, codexPre],
    "bob",
    JSON.stringify(allowedPayload),
  );
  expect(allowed.code).toBe(0);
  expect(allowed.stdout).toBe("");
  const claimed = (await bob.request({ op: "reservations" })) as Array<{
    actor: string;
    logical_path: string;
  }>;
  expect(
    claimed
      .filter((r) => r.actor === "bob")
      .map((r) => r.logical_path)
      .sort(),
  ).toEqual(["original.txt", "renamed.txt"]);
  await run([python, codexPost], "bob", JSON.stringify(allowedPayload));
}, 30000);

test("Node owner recovers expired grants and rejects stale client release", async () => {
  const alice = await connect("alice"),
    bob = await connect("bob");
  const first = (await alice.request({
    op: "command",
    command: {
      id: "short-lease",
      type: "reservation.acquire",
      payload: {
        kind: "file",
        paths: ["expired.txt"],
        reason: "crashed tool",
        leaseMs: 50,
      },
    },
  })) as { value: { grants: Array<{ id: string; fence: number }> } };
  alice.close();
  await new Promise((resolve) => setTimeout(resolve, 75));
  const next = (await bob.request({
    op: "command",
    command: {
      id: "replacement",
      type: "reservation.acquire",
      payload: { kind: "file", paths: ["expired.txt"], reason: "recover tool" },
    },
  })) as {
    value: { acquired: boolean; grants: Array<{ id: string; fence: number }> };
  };
  expect(next.value.acquired).toBe(true);
  expect(next.value.grants[0]!.fence).toBeGreaterThan(
    first.value.grants[0]!.fence,
  );
  const resumed = await connect("alice");
  const stale = await resumed
    .request({
      op: "command",
      command: {
        id: "stale-release",
        type: "reservation.release",
        payload: {
          grants: first.value.grants.map((g) => ({ id: g.id, fence: g.fence })),
        },
      },
    })
    .catch((error) => error);
  expect(stale).toHaveProperty("code", "stale_reservation");
  await bob.request({
    op: "command",
    command: {
      id: "release-replacement",
      type: "reservation.release",
      payload: {
        grants: next.value.grants.map((g) => ({ id: g.id, fence: g.fence })),
      },
    },
  });
}, 30000);
