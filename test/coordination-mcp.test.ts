import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

test("compact MCP executes durable task and inbox workflows through the Node owner", async () => {
  mkdirSync(resolve("dist/test"), { recursive: true });
  const dir = mkdtempSync(resolve("dist/test/compact-"));
  await build({
    entryPoints: [
      "test/fixtures/coordination-service.ts",
      "src/coordination/mcp-cli.ts",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    outdir: dir,
    outbase: ".",
  });
  const root = mkdtempSync(join(tmpdir(), "swarm-compact-"));
  const owner = Bun.spawn({
    cmd: [
      Bun.which("node")!,
      join(dir, "test/fixtures/coordination-service.js"),
      join(root, "db"),
      "sessions",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = new Client(
    { name: "compact-test", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    const reader = owner.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (!first.value) throw new Error(await new Response(owner.stderr).text());
    const { endpoint, capability } = JSON.parse(
      new TextDecoder().decode(first.value),
    );
    await client.connect(
      new StdioClientTransport({
        command: Bun.which("node")!,
        args: [join(dir, "src/coordination/mcp-cli.js")],
        env: {
          ...getDefaultEnvironment(),
          SWARM_COORDINATOR_ENDPOINT: endpoint,
          SWARM_SESSION_CAPABILITY: capability,
        },
        stderr: "pipe",
      }),
    );
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(9);
    expect(catalog.tools.every((t) => t.outputSchema)).toBe(true);
    expect(
      catalog.tools.find((t) => t.name === "swarm_inbox")!.annotations!
        .readOnlyHint,
    ).toBe(false);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).toBe(false);
      return (response.structuredContent as any).data;
    };
    expect((await call("swarm_sync", {})).actor).toBe("alice");
    const assignment = {
      commandId: "assign",
      title: "verify",
      contract: {
        objective: "Verify IPC",
        worktree: root,
        acceptanceCriteria: ["real owner roundtrip"],
        expectedArtifacts: ["test output"],
        constraints: [],
      },
    };
    const assigned = await call("swarm_assign", assignment);
    const taskId = assigned.value.task.id;
    expect((await call("swarm_assign", assignment)).replayed).toBe(true);
    const claim = (
      await call("swarm_task", {
        action: "claim",
        commandId: "claim",
        taskId,
        expectedVersion: 1,
      })
    ).value;
    const detail = await call("swarm_find", { kind: "task", taskId });
    expect(detail).toMatchObject({
      taskId,
      scope: "test",
      contract: assignment.contract,
      dependencies: [],
      owner: {
        actor: "alice",
        attemptId: claim.attemptId,
        fence: claim.fence,
        active: true,
      },
    });
    expect((await call("swarm_wait", { taskId, timeoutMs: 1 })).waitState).toBe(
      "timeout",
    );
    const stale = await client.callTool({
      name: "swarm_task",
      arguments: {
        action: "claim",
        commandId: "stale",
        taskId,
        expectedVersion: 1,
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    await call("swarm_task", {
      action: "finish",
      commandId: "finish",
      taskId,
      attemptId: claim.attemptId,
      fence: claim.fence,
      outcome: "completed",
      report: { summary: "verified", evidence: ["roundtrip"], limitations: [] },
    });
    expect(await call("swarm_find", { kind: "task", taskId })).toMatchObject({
      owner: null,
      result: { summary: "verified", evidence: ["roundtrip"], limitations: [] },
    });
    expect((await call("swarm_wait", { taskId, timeoutMs: 0 })).waitState).toBe(
      "terminal",
    );
    await call("swarm_send", {
      commandId: "send",
      recipient: "alice",
      kind: "completion_notice",
      body: "verified",
      threadId: taskId,
      taskId,
    });
    const fetched = await call("swarm_inbox", {
      commandId: "fetch",
      action: "fetch",
      consumer: "test",
    });
    const delivery = fetched.value.deliveries[0];
    expect(delivery.message).toMatchObject({
      taskId,
      threadId: taskId,
      kind: "completion_notice",
    });
    await call("swarm_inbox", {
      commandId: "ack",
      action: "ack",
      messageId: delivery.message.id,
      leaseToken: delivery.leaseToken,
    });
    expect(
      (
        await call("swarm_inbox", {
          commandId: "fetch-next",
          action: "fetch",
          consumer: "test",
        })
      ).value.deliveries,
    ).toEqual([]);
    await call("swarm_context", {
      action: "set",
      commandId: "context",
      key: "report",
      expectedVersion: 0,
      value: { taskId },
    });
    expect(
      await call("swarm_context", { action: "get", key: "report" }),
    ).toMatchObject({ version: 1, value: { taskId } });
    const shared = await client.readResource({
      uri: "swarm://context?key=report",
    });
    expect(
      JSON.parse((shared.contents[0] as { text: string }).text),
    ).toMatchObject({ version: 1, value: { taskId } });
    const report = "artifact verification\n".repeat(2000);
    writeFileSync(join(root, "report.txt"), report);
    const capture = await call("swarm_evidence", {
      action: "capture",
      commandId: "capture",
      path: "report.txt",
      summary: "test report",
      mediaType: "text/plain",
    });
    unlinkSync(join(root, "report.txt"));
    const chunks: Buffer[] = [];
    let uri: string | null = capture.value.uri;
    while (uri) {
      const resource = await client.readResource({ uri });
      const blob = resource.contents.find((item) => "blob" in item) as {
        blob: string;
      };
      chunks.push(Buffer.from(blob.blob, "base64"));
      const page = resource.contents.find((item) => "text" in item) as {
        text: string;
      };
      uri = JSON.parse(page.text).nextUri;
    }
    expect(Buffer.concat(chunks).toString()).toBe(report);
    const revision = "a".repeat(40);
    await call("swarm_evidence", {
      action: "record",
      commandId: "record",
      kind: "annotation",
      summary: "verified implementation",
      revision,
      files: ["src/main.ts"],
      verification: "integration test",
      artifactIds: [capture.value.artifactId],
    });
    const findings = await client.readResource({
      uri: `swarm://findings?filter=${encodeURIComponent(JSON.stringify({ file: "src/main.ts", currentRevision: revision }))}`,
    });
    expect(
      JSON.parse((findings.contents[0] as { text: string }).text).items[0],
    ).toMatchObject({
      freshness: "current",
      artifactIds: [capture.value.artifactId],
    });
  } finally {
    await client.close();
    owner.kill();
    await owner.exited;
  }
}, 15000);
