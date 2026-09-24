import { expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createCoordinatorMcp } from "../src/coordination/mcp";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

for (const mode of ["modern", "legacy"] as const)
  test(`compact MCP executes durable workflows through the Node owner (${mode})`, async () => {
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
        "dispatch",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const client = new Client(
      { name: "compact-test", version: "1" },
      {
        versionNegotiation: {
          mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy",
        },
      },
    );
    try {
      const reader = owner.stdout.getReader();
      const first = await reader.read();
      reader.releaseLock();
      if (!first.value)
        throw new Error(await new Response(owner.stderr).text());
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
      expect(client.getInstructions()).toContain("1..128");
      expect(client.getInstructions()).toContain("1..1024");
      for (const arguments_ of [
        { commandId: "x".repeat(129), title: "valid" },
        { commandId: "valid", title: "x".repeat(1025) },
      ]) {
        const invalid = await client.callTool({
          name: "swarm_assign",
          arguments: {
            ...arguments_,
            contract: {
              objective: "validate bounds",
              worktree: root,
              acceptanceCriteria: ["reject"],
              expectedArtifacts: [],
              constraints: [],
            },
          },
        });
        expect(invalid.isError).toBe(true);
      }
      const notifications: string[] = [];
      client.setNotificationHandler("notifications/resources/updated", (n) => {
        notifications.push(n.params.uri);
      });
      const listen = async (uri: string) => {
        if (mode === "modern")
          return client.listen({ resourceSubscriptions: [uri] });
        await client.subscribeResource({ uri });
        return { close: () => client.unsubscribeResource({ uri }) };
      };
      const taskSubscription = await listen("swarm://tasks");
      expect(catalog.tools).toHaveLength(9);
      expect(catalog.tools.every((t) => t.outputSchema)).toBe(true);
      const detailed = await client.readResource({ uri: "swarm://schemas/swarm_task" });
      expect(JSON.parse((detailed.contents[0] as { text: string }).text).anyOf).toBeDefined();
      for (const name of ["swarm_task", "swarm_context", "swarm_inbox"])
        expect(
          catalog.tools.find((t) => t.name === name)!.annotations!
            .destructiveHint,
        ).toBe(true);
      expect(
        catalog.tools.find((t) => t.name === "swarm_inbox")!.annotations!
          .readOnlyHint,
      ).toBe(false);
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError).toBe(false);
        return (response.structuredContent as any).data;
      };
      expect(await call("swarm_sync", {})).toMatchObject({ actor: "alice", recipientGeneration: true });
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
      const deadline = Date.now() + 1000;
      while (!notifications.length && Date.now() < deadline) await delay(10);
      expect(notifications).toEqual(["swarm://tasks"]);
      await taskSubscription.close();
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
      const timedOut = await call("swarm_wait", { taskId, timeoutMs: 1 });
      expect(timedOut.waitState).toBe("timeout");
      // More than the adapter's eight-wait ceiling proves cancelled waits give
      // their slots back. Cancelling transport waits must never cancel work.
      for (let i = 0; i < 9; i++) {
        const controller = new AbortController();
        const pending = client
          .callTool(
            { name: "swarm_wait", arguments: { taskId, timeoutMs: 30000 } },
            { signal: controller.signal },
          )
          .catch((error) => error);
        await delay(50);
        controller.abort();
        expect(await pending).toBeInstanceOf(Error);
        expect(
          (await call("swarm_find", { kind: "task", taskId })).status,
        ).toBe("running");
      }
      expect(
        (await call("swarm_wait", { taskId, timeoutMs: 0 })).waitState,
      ).toBe("timeout");
      const resumed = await client.readResource({ uri: timedOut.uri });
      expect(
        JSON.parse((resumed.contents[0] as { text: string }).text),
      ).toMatchObject({ taskId, status: "running", owner: { actor: "alice" } });
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
        error: { code: "conflict", retryable: false },
      });
      await call("swarm_task", {
        action: "finish",
        commandId: "finish",
        taskId,
        attemptId: claim.attemptId,
        fence: claim.fence,
        outcome: "completed",
        report: {
          summary: "verified",
          evidence: ["roundtrip"],
          limitations: [],
        },
      });
      expect(await call("swarm_find", { kind: "task", taskId })).toMatchObject({
        owner: null,
        result: {
          summary: "verified",
          evidence: ["roundtrip"],
          limitations: [],
        },
      });
      expect(
        (await call("swarm_wait", { taskId, timeoutMs: 0 })).waitState,
      ).toBe("terminal");
      for (const kind of ["completion_notice", "reply"]) {
        await call("swarm_send", {
          commandId: `send-${kind}`,
          recipient: "alice",
          recipientGeneration: 1,
          kind,
          body: "verified",
          threadId: taskId,
          taskId,
        });
        const fetched = await call("swarm_inbox", {
          commandId: `fetch-${kind}`,
          action: "fetch",
          consumer: "test",
        });
        const delivery = fetched.value.deliveries[0];
        expect(delivery.message).toMatchObject({
          recipientGeneration: 1,
          taskId,
          threadId: taskId,
          kind,
        });
        await call("swarm_inbox", {
          commandId: `ack-${kind}`,
          action: "ack",
          messageId: delivery.message.id,
          leaseToken: delivery.leaseToken,
        });
      }
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
      const evidencePage = await call("swarm_evidence", { action: "read", commandId: "read-report", artifactId: capture.value.artifactId });
      expect(Buffer.from(evidencePage.data, "base64").toString()).toBe(report.slice(0, 32768));
      writeFileSync(join(root, "instructions.md"), "Preference 🐑");
      const instructions = await call("swarm_evidence", { action: "capture", commandId: "capture-instructions", path: "instructions.md", summary: "Instructions", mediaType: "text/markdown" });
      const instructionPage = await call("swarm_evidence", { action: "read", commandId: "read-instructions", artifactId: instructions.value.artifactId });
      expect(instructionPage.text).toBe("Preference 🐑");
      expect(instructionPage.data).toBeNull();
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
      const contextSubscription = await listen("swarm://context");
      await call("swarm_context", {
        action: "set",
        commandId: "context-barrier",
        key: "barrier",
        expectedVersion: 0,
        value: true,
      });
      const barrierDeadline = Date.now() + 1000;
      while (
        !notifications.includes("swarm://context") &&
        Date.now() < barrierDeadline
      )
        await delay(10);
      expect(notifications).toEqual(["swarm://tasks", "swarm://context"]);
      await contextSubscription.close();
      const routed = {
        ...assignment,
        commandId: "routed",
        contract: { ...assignment.contract, instructions: [instructions.value.uri] },
        routing: { capabilities: ["code"], durable: true },
      };
      const dispatched = await call("swarm_assign", routed);
      expect(dispatched.status).toBe("bound");
      expect((await call("swarm_find", { kind: "task", taskId: dispatched.taskId })).contract.instructions).toEqual([instructions.value.uri]);
      expect((await call("swarm_assign", routed)).attemptId).toBe(
        dispatched.attemptId,
      );
      expect(
        (
          await call("swarm_task", {
            action: "cancel",
            commandId: "cancel-routed",
            taskId: dispatched.taskId,
            intentId: "routed",
          })
        ).status,
      ).toBe("uncertain");
    } finally {
      const closingAt = Date.now();
      await client.close();
      owner.kill();
      await owner.exited;
      expect(Date.now() - closingAt).toBeLessThan(1500);
    }
  }, 15000);

test("pinned MCP sends refuse owners without generation fencing", async () => {
  const requested: string[] = [];
  const server = createCoordinatorMcp(async (operation) => {
    requested.push(operation.op);
    if (operation.op === "bootstrap") return {};
    throw new Error("A pinned message must never reach this older owner");
  });
  const client = new Client({ name: "pin-compatibility", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "swarm_send", arguments: {
      commandId: "pinned", recipient: "peer", recipientGeneration: 1,
      kind: "question", body: "For one session", threadId: "contact",
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("generation fencing");
    expect(requested).toEqual(["bootstrap"]);
  } finally {
    await client.close();
    await server.close();
  }
});
