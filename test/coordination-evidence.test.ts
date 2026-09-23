import { afterEach, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationStore } from "../src/coordination/store";
import { CoordinationCore } from "../src/coordination/core";
import type { FindingPayload } from "../src/coordination/evidence";
const stores: CoordinationStore[] = [];
let nodeWorker: string;
beforeAll(async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  nodeWorker = join(mkdtempSync(resolve("dist/test/evidence-")), "worker.mjs");
  await build({
    entryPoints: ["test/fixtures/evidence-worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outfile: nodeWorker,
  });
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const rev = "a".repeat(40);
async function fixture() {
  let now = 1000,
    fault = false;
  const root = mkdtempSync(join(tmpdir(), "swarm-evidence-")),
    path = join(root, "db.sqlite");
  const open = async () => {
    const store = await CoordinationStore.open({
      path,
      clock: () => now,
      fault: (point) => {
        if (fault && point === "before_command_commit")
          throw new Error("before metadata commit");
      },
    });
    stores.push(store);
    return { store, core: new CoordinationCore(store) };
  };
  const { store, core } = await open();
  const actor = store.openSession({
    scope: "test",
    agentId: "alice",
    requestId: "enroll",
    resumeToken: randomBytes(32).toString("hex"),
    worktree: { root, repository: root },
  });
  return {
    root,
    path,
    store,
    core,
    actor,
    open,
    advance: (ms: number) => {
      now += ms;
    },
    fail: () => {
      fault = true;
    },
    recover: () => {
      fault = false;
    },
  };
}
function id(result: { value: unknown }) {
  return (result.value as { artifactId: string }).artifactId;
}
const finding = (artifactIds: string[] = []): FindingPayload => ({
  kind: "annotation",
  summary: "Parser requires a stable rename target",
  revision: rev,
  files: ["src/parser.ts"],
  verification: "Regression test passes",
  artifactIds,
});

test("retention changes require the author and findings reject unstable provenance", async () => {
  const e = await fixture();
  const recorded = e.core.command(e.actor, {
    id: "record",
    type: "finding.record",
    payload: finding(),
  }).value as { findingId: string };
  const other = e.store.openSession({
    scope: "test",
    agentId: "bob",
    requestId: "bob",
    resumeToken: randomBytes(32).toString("hex"),
  });
  expect(() =>
    e.core.command(other, {
      id: "expire",
      type: "retention.set",
      payload: {
        kind: "finding",
        entityId: recorded.findingId,
        expiresAt: 1000,
      },
    }),
  ).toThrow("Only the author");
  expect((await e.core.findings(e.actor)).items[0]!.status).toBe("retained");
  for (const payload of [
    { ...finding(), revision: "main" },
    { ...finding(), files: ["../secret"] },
  ]) {
    expect(() =>
      e.core.command(e.actor, {
        id: "invalid",
        type: "finding.record",
        payload,
      }),
    ).toThrow();
  }
  const task = e.core.command(e.actor, {
    id: "task",
    type: "task.create",
    payload: { title: "verify" },
  }).value as { task: { id: string; version: number } };
  const claim = e.core.command(e.actor, {
    id: "claim",
    type: "task.claim",
    payload: { taskId: task.task.id, expectedVersion: task.task.version },
  }).value as { attemptId: string };
  e.advance(300001);
  expect(() =>
    e.core.command(e.actor, {
      id: "late-result",
      type: "finding.record",
      payload: {
        ...finding(),
        kind: "result",
        taskId: task.task.id,
        attemptId: claim.attemptId,
      },
    }),
  ).toThrow("current session");
  expect((await e.core.findings(e.actor)).items).toHaveLength(1);
});
test("immutable capture survives source removal/restart and replays the original receipt", async () => {
  const e = await fixture(),
    source = join(e.root, "report.txt"),
    contents = "verified report\n".repeat(6000);
  writeFileSync(source, contents);
  const input = {
    id: "capture",
    path: "report.txt",
    summary: "verification log",
    mediaType: "text/plain",
  };
  const captured = await e.core.importArtifact(e.actor, input),
    artifactId = id(captured);
  unlinkSync(source);
  e.store.close();
  const { core } = await e.open();
  expect(await core.importArtifact(e.actor, input)).toEqual({
    ...captured,
    replayed: true,
  });
  const chunks: Buffer[] = [];
  let offset = 0;
  while (true) {
    const page = await core.readArtifact(e.actor, artifactId, offset, 32000);
    if (!page.data) break;
    chunks.push(Buffer.from(page.data, "base64"));
    offset = (page as { nextOffset: number }).nextOffset;
  }
  expect(Buffer.concat(chunks).toString()).toBe(contents);
  expect((await core.artifact(e.actor, artifactId)).status).toBe("available");
});
test("metadata failure leaves no accepted reference and retry uses a complete blob", async () => {
  const e = await fixture();
  writeFileSync(join(e.root, "out.txt"), "complete bytes");
  e.fail();
  const input = { id: "capture", path: "out.txt", summary: "log" };
  const failure = await e.core
    .importArtifact(e.actor, input)
    .catch((error) => error);
  expect(failure.message).toBe("before metadata commit");
  expect((await e.core.artifacts(e.actor)).items).toEqual([]);
  e.recover();
  const captured = await e.core.importArtifact(e.actor, input);
  expect((await e.core.artifact(e.actor, id(captured))).status).toBe(
    "available",
  );
});
test("findings expose annotation freshness, provenance and missing/expired artifact references", async () => {
  const e = await fixture();
  writeFileSync(join(e.root, "test.log"), "passed");
  const imported = await e.core.importArtifact(e.actor, {
      id: "capture",
      path: "test.log",
      summary: "test output",
    }),
    artifactId = id(imported);
  e.core.command(e.actor, {
    id: "finding",
    type: "finding.record",
    payload: finding([artifactId]),
  });
  const current = await e.core.findings(e.actor, {
    file: "src/parser.ts",
    currentRevision: rev,
  });
  expect(current.items[0]).toMatchObject({
    author: "alice",
    revision: rev,
    verification: "Regression test passes",
    freshness: "current",
    createdAt: 1000,
  });
  expect(
    (await e.core.findings(e.actor, { currentRevision: "b".repeat(40) }))
      .items[0]!.freshness,
  ).toBe("stale");
  expect((await e.core.findings(e.actor)).items[0]!.freshness).toBe("unknown");
  e.core.command(e.actor, {
    id: "expire",
    type: "retention.set",
    payload: { kind: "artifact", entityId: artifactId, expiresAt: 1000 },
  });
  expect((await e.core.findings(e.actor)).items[0]!.artifacts[0]!.status).toBe(
    "expired",
  );
  expect((await e.core.readArtifact(e.actor, artifactId)).data).toBeNull();
  e.core.command(e.actor, {
    id: "retain",
    type: "retention.set",
    payload: { kind: "artifact", entityId: artifactId, expiresAt: null },
  });
  const row = e.store.artifact(e.actor.scope, artifactId)!;
  unlinkSync(e.store.artifactFiles.path(e.actor.scope, row.digest));
  expect((await e.core.findings(e.actor)).items[0]!.artifacts[0]!.status).toBe(
    "missing",
  );
  expect((await e.core.readArtifact(e.actor, artifactId)).status).toBe(
    "missing",
  );
});
test("artifact reads detect corruption and reject cross-scope references", async () => {
  const e = await fixture();
  writeFileSync(join(e.root, "log.txt"), "good");
  const artifactId = id(
    await e.core.importArtifact(e.actor, {
      id: "capture",
      path: "log.txt",
      summary: "log",
    }),
  );
  const row = e.store.artifact(e.actor.scope, artifactId)!;
  expect((await e.core.readArtifact(e.actor, artifactId)).status).toBe(
    "available",
  );
  writeFileSync(e.store.artifactFiles.path(e.actor.scope, row.digest), "evil");
  expect((await e.core.readArtifact(e.actor, artifactId)).status).toBe(
    "corrupt",
  );
  const other = e.store.openSession({
    scope: "other",
    agentId: "alice",
    requestId: "other",
    resumeToken: randomBytes(32).toString("hex"),
  });
  expect((await e.core.artifact(other, artifactId)).status).toBe(
    "missing_reference",
  );
  expect(() =>
    e.core.command(other, {
      id: "link",
      type: "finding.record",
      payload: finding([artifactId]),
    }),
  ).toThrow("outside this scope");
});
test("task result provenance and explicit retention preserve control history", async () => {
  const e = await fixture();
  const task = e.core.command(e.actor, {
    id: "task",
    type: "task.create",
    payload: { title: "verify" },
  }).value as { task: { id: string; version: number } };
  const taskId = task.task.id;
  const claim = e.core.command(e.actor, {
    id: "claim",
    type: "task.claim",
    payload: { taskId, expectedVersion: task.task.version },
  }).value as { attemptId: string; fence: number };
  expect(() =>
    e.core.command(e.actor, {
      id: "expire-active",
      type: "retention.set",
      payload: { kind: "task", entityId: taskId, expiresAt: 1000 },
    }),
  ).toThrow("Active tasks");
  e.core.command(e.actor, {
    id: "result",
    type: "finding.record",
    payload: {
      ...finding(),
      kind: "result",
      taskId,
      attemptId: claim.attemptId,
    },
  });
  e.core.command(e.actor, {
    id: "finish",
    type: "task.finish",
    payload: {
      taskId,
      ...claim,
      outcome: "completed",
      result: { summary: "verified" },
    },
  });
  const results = await e.core.findings(e.actor, { taskId });
  expect(results.items[0]!.attemptId).toBe(claim.attemptId);
  e.core.command(e.actor, {
    id: "retention",
    type: "retention.set",
    payload: { kind: "task", entityId: taskId, expiresAt: 1001 },
  });
  e.advance(1);
  expect(e.core.task(e.actor, taskId)).toMatchObject({
    status: "completed",
    retentionState: "expired",
    result: null,
  });
  expect(e.core.attempts(e.actor, taskId)[0]).toMatchObject({
    state: "completed",
    retentionState: "expired",
    result: null,
  });
  expect((await e.core.findings(e.actor, { taskId })).items).toHaveLength(1);
});
test("finding pagination and retention boundaries remain visible after restart", async () => {
  const e = await fixture();
  for (let i = 0; i < 3; i++)
    e.core.command(e.actor, {
      id: `finding-${i}`,
      type: "finding.record",
      payload: { ...finding(), ttlMs: 10 },
    });
  const first = await e.core.findings(e.actor, { limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(
    (await e.core.findings(e.actor, { cursor: first.cursor, limit: 2 })).items,
  ).toHaveLength(1);
  e.advance(10);
  e.store.close();
  const { core } = await e.open();
  expect(
    (await core.findings(e.actor)).items.every(
      (item) => item.status === "expired",
    ),
  ).toBe(true);
  expect(
    (await core.findings(e.actor, { file: "src/other.ts" })).items,
  ).toEqual([]);
});

for (const runtime of ["bun", "node"] as const)
  for (const crash of [
    "before_command_commit",
    "after_command_commit",
  ] as const)
    test(`artifact ${crash} process exit recovers without partial references (${runtime})`, async () => {
      const e = await fixture(),
        source = join(e.root, "crash.log");
      writeFileSync(source, "captured evidence\n".repeat(10000));
      const input = {
        id: "crash-capture",
        path: "crash.log",
        summary: "crash proof",
      };
      const proc = Bun.spawn({
        cmd: [
          runtime === "bun" ? process.execPath : Bun.which("node")!,
          runtime === "bun"
            ? resolve("test/fixtures/evidence-worker.ts")
            : nodeWorker,
          e.path,
          e.actor.capability,
          JSON.stringify(input),
          crash,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(73);
      expect(out).toBe("");
      expect(err).toBe("");
      const before = await e.core.artifacts(e.actor);
      expect(before.items).toHaveLength(
        crash === "after_command_commit" ? 1 : 0,
      );
      if (crash === "after_command_commit") unlinkSync(source);
      e.store.close();
      const { core } = await e.open();
      const recovered = await core.importArtifact(e.actor, input);
      expect(recovered.replayed).toBe(crash === "after_command_commit");
      expect((await core.readArtifact(e.actor, id(recovered))).status).toBe(
        "available",
      );
    });
