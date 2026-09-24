import { gitDiffHash } from "./fixtures/source-state";
import { build } from "esbuild";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { CoordinationClient } from "../src/coordination/ipc";
import { canonicalPath } from "../src/coordination/worktrees";
import { mixedClaude } from "./fixtures/mixed-claude";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { processMemory } from "./fixtures/process-memory";

const [output, binary, claudeBinary] = process.argv.slice(2);
let mixed: Awaited<ReturnType<typeof mixedClaude>> | undefined;
let mixedRun: Promise<any> | undefined;
let mixedError: unknown;
if (!output || !binary)
  throw new Error(
    "Usage: bun scripts/probe-opencode-dispatch.ts output.json native-opencode-binary [claude-binary]",
  );
const root = mkdtempSync(join(tmpdir(), "swarm-native-dispatch-"));
mkdirSync(resolve("dist/test"), { recursive: true });
const bundle = mkdtempSync(resolve("dist/test/native-dispatch-"));
await build({
  entryPoints: [
    "src/coordination/opencode-plugin.ts",
    "scripts/fixtures/runtime-dispatch-result.ts",
    "scripts/fixtures/runtime-mixed-question.ts",
  ],
  outdir: bundle,
  outbase: ".",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const resultScript = join(
  bundle,
  "scripts/fixtures/runtime-dispatch-result.js",
).replaceAll("\\", "/");
const modelRequests: unknown[] = [];
const toolCalls: unknown[] = [];
const tokens = new Set<string>();
const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json();
    modelRequests.push(body);
    if (modelRequests.length > (claudeBinary ? 10 : 6))
      return new Response("Fixture model budget exceeded", { status: 400 });
    const texts = strings(body.messages);
    const done = texts.some((text) =>
      text.includes("swarm-dispatch-completed"),
    );
    const leases = texts
      .flatMap((text) => text.split("\n"))
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return ["task.assigned", "completion_notice"].includes(value.message?.kind) && value.leaseToken
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
    const reply = leases.find(value => value.message.kind === "completion_notice");
    const lease = reply ?? leases.at(-1);
    let toolCall;
    const questionSent = texts.some(text => text.includes("swarm-mixed-question-sent"));
    if (!done && lease && (!mixed || reply || !questionSent)) {
      tokens.add(lease.leaseToken);
      const assignment = JSON.parse(lease.message.body);
      const args = [
        ...(mixed && !reply ? [mixed.actor] : []),
        assignment.taskId,
        assignment.attemptId,
        String(assignment.fence),
        lease.message.id,
        lease.leaseToken,
      ];
      assert.ok(args.every((value) => /^[a-zA-Z0-9-]+$/.test(value)));
      toolCall = {
        name: "bash",
        arguments: JSON.stringify({
          command: `node "${mixed && !reply ? join(bundle, "scripts/fixtures/runtime-mixed-question.js").replaceAll("\\", "/") : resultScript}" ${args.join(" ")}`,
          description:
            mixed && !reply ? "Ask the Claude peer and acknowledge the assignment"
              : "Publish the fenced fixture result and acknowledge delivery",
        }),
      };
      toolCalls.push({ at: Date.now(), ...toolCall });
    }
    const chunks = toolCall
      ? [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_result",
                  type: "function",
                  function: toolCall,
                },
              ],
            },
            finish_reason: null,
          },
          { delta: {}, finish_reason: "tool_calls" },
        ]
      : [
          {
            delta: { role: "assistant", content: "Fixture complete" },
            finish_reason: null,
          },
          { delta: {}, finish_reason: "stop" },
        ];
    return new Response(
      chunks
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, ...choice }] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const options = {
  stateDirectory: join(root, "private"),
  nodePath: Bun.which("node")!,
  ownerPath: resolve("dist/coordination/owner-cli.js"),
  identity: {
    projectRoot: root,
    directory: root,
    fileRoot: root,
    profile: "probe",
    allowedRoots: [root],
  },
};
let observer = await enrollRuntime({
  ...options,
  host: "opencode",
  hostSessionId: "observer",
  incarnation: "probe",
});
const eventsPath = join(root, "events.jsonl");
const plugin = join(root, "plugin.mjs");
writeFileSync(
  plugin,
  `import {appendFileSync} from 'node:fs';
import {opencodeLifecycle,connectOpenCodeLifecycle} from ${JSON.stringify(pathToFileURL(join(bundle, "src/coordination/opencode-plugin.js")).href)};
export const Probe = async ({directory,client,serverUrl}) => {
 const record = e => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(e)+'\\n');
 const hooks = opencodeLifecycle(${JSON.stringify(options)},record);
 connectOpenCodeLifecycle({directory,client,serverUrl},hooks,state=>record({type:state}));
 return {...hooks,event:async()=>{}};
};`,
);
const env: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("SWARM_") || key.startsWith("OPENCODE_")) delete env[key];
Object.assign(env, {
  OPENCODE_DB: join(root, "host.db"),
  OPENCODE_TEST_HOME: join(root, "home"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    plugin: [pathToFileURL(plugin).href],
    enabled_providers: ["fixture"],
    model: "fixture/probe",
    small_model: "fixture/probe",
    permission: { bash: "allow" },
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local fixture",
        options: {
          baseURL: `http://127.0.0.1:${model.port}/v1`,
          apiKey: "fixture",
        },
        models: {
          probe: { name: "probe", limit: { context: 32768, output: 1024 } },
        },
      },
    },
    agent: { title: { disable: true }, summary: { disable: true } },
  }),
});
const host = Bun.spawn({
  cmd: [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
  cwd: root,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const stderr = new Response(host.stderr).text();
let client: CoordinationClient | undefined;
const waitFor = async <T>(
  check: () => Promise<T | undefined>,
  label: string,
) => {
  for (let i = 0; i < (claudeBinary ? 900 : 150); i++) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
};
try {
  let text = "";
  const ready = (async () => {
    for await (const chunk of host.stdout) {
      text += new TextDecoder().decode(chunk);
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) return match[0];
    }
    throw new Error(await stderr);
  })();
  const base = await Promise.race([
    ready,
    delay(20000, undefined, { ref: false }).then(() => {
      throw new Error("Host readiness timeout");
    }),
  ]);
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const parent = await api("/session", { title: "Native dispatch parent" });
  client = await CoordinationClient.connect(
    observer.environment.SWARM_COORDINATOR_ENDPOINT,
    observer.environment.SWARM_SESSION_CAPABILITY,
  );
  const enrollment = await waitFor(async () => {
    const events = existsSync(eventsPath)
      ? readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    return events.find(
      (event) => event.type === "enrolled" && event.hostSessionId === parent.id,
    );
  }, "parent enrollment");
  await api(`/session/${parent.id}/shell`, {
    agent: "build",
    model: { providerID: "fixture", modelID: "probe" },
    command: "echo dispatch-parent-ready",
  });
  const peer = await waitFor(async () => {
    const peers = (await client!.request({ op: "peers" })) as any;
    return peers.items.find(
      (p: any) =>
        p.agentId === enrollment.actor && p.runtimeState === "available",
    );
  }, "parent availability");
  const ownerConfig = join(options.stateDirectory, "owner.json");
  const config = JSON.parse(readFileSync(ownerConfig, "utf8"));
  config.dispatch = {
    maximum: 1,
    observationMaxAgeMs: 60000,
    peers: [],
    opencode: [
      {
        id: "native",
        parent: {
          scope: observer.scope,
          actor: peer.agentId,
          sessionId: peer.sessionId,
          generation: peer.generation,
        },
        parentSessionId: parent.id,
        baseUrl: base,
        stateDirectory: options.stateDirectory,
        capabilities: ["code"],
        durable: false,
        capacity: 1,
        overhead: 0,
      },
    ],
  };
  writeFileSync(ownerConfig, JSON.stringify(config));
  client.close();
  assert.ok(observer.launchedOwner);
  observer.launchedOwner.ref();
  const stopped = once(observer.launchedOwner, "exit");
  observer.launchedOwner.kill();
  await stopped;
  observer = await enrollRuntime({
    ...options,
    host: "opencode",
    hostSessionId: "observer",
    incarnation: "probe",
  });
  client = await CoordinationClient.connect(
    observer.environment.SWARM_COORDINATOR_ENDPOINT,
    observer.environment.SWARM_SESSION_CAPABILITY,
  );
  const input = {
    action: "assign" as const,
    intent: {
      intentId: "native-probe",
      title: "Native dispatch fixture",
      capabilities: ["code"],
      durable: false,
      contract: {
        objective: claudeBinary ? "Ask the Claude peer, receive its reply and publish a fenced result" : "Publish a fenced fixture result",
        worktree: canonicalPath(root),
        acceptanceCriteria: [
          "One completed attempt and explicit delivery acknowledgment",
          ...(claudeBinary ? ["Actual Claude peer reply received and both peer messages acknowledged"] : []),
        ],
        expectedArtifacts: [],
        constraints: ["Local fixture only"],
      },
    },
  };
  if (claudeBinary) mixed = await mixedClaude(options, claudeBinary, tokens);
  const taskSubmittedAt = Date.now();
  const results: unknown[] = [];
  const bound = await waitFor(async () => {
    const result = (await client!.request({ op: "dispatch", input })) as any;
    results.push(result);
    return result.status === "bound" ? result : undefined;
  }, "native binding");
  const completed = await waitFor(async () => {
    if (mixed && !mixedRun) {
      const db = new Database(join(options.stateDirectory, "coordination.db"), { readonly: true });
      try {
        const pending = db.query("SELECT count(*) AS n FROM inbox_deliveries WHERE recipient=? AND state='pending'").get(mixed.actor) as { n: number };
        // Claude has no idle wake: this is an explicit fixture user-turn invocation.
        if (pending.n) mixedRun = mixed.launch().catch(error => { mixedError = error; });
      } finally { db.close(); }
    }
    if (mixedError) throw mixedError;
    const task = (await client!.request({
      op: "task_detail",
      taskId: bound.taskId,
    })) as any;
    return task.status === "completed" ? task : undefined;
  }, "native result");
  const taskCompletedAt = Date.now();
  const claudeResult = mixedRun ? await mixedRun : undefined;
  if (mixedError) throw mixedError;
  let mixedDeliveries: unknown;
  if (mixed) {
    assert.ok(claudeResult, "Claude was never invoked");
    const db = new Database(join(options.stateDirectory, "coordination.db"), { readonly: true });
    try {
      const rows = db.query("SELECT m.kind,m.sender,d.recipient,d.state,d.attempts,m.created_at,d.acknowledged_at FROM inbox_deliveries d JOIN inbox_messages m ON m.id=d.message_id WHERE m.kind IN ('question','completion_notice') ORDER BY m.seq").all() as any[];
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.state === "acknowledged"));
      assert.equal(rows[0].recipient, mixed.actor);
      assert.equal(rows[1].sender, mixed.actor);
      assert.equal(rows[0].sender, rows[1].recipient);
      assert.equal(mixed.calls.length, 2);
      assert.equal(toolCalls.length, 2);
      mixedDeliveries = rows;
    } finally { db.close(); }
  }
  const attempts = (await client.request({
    op: "attempts",
    taskId: bound.taskId,
  })) as any[];
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "completed");
  const acknowledged = await waitFor(async () => {
    const db = new Database(join(options.stateDirectory, "coordination.db"), {
      readonly: true,
    });
    try {
      const rows = db
        .query(
          "SELECT d.state,d.attempts FROM inbox_deliveries d JOIN inbox_messages m ON m.id=d.message_id WHERE m.task_id=? AND m.kind='task.assigned'",
        )
        .all(bound.taskId) as Array<{ state: string; attempts: number }>;
      return rows.length === 1 && rows[0]!.state === "acknowledged"
        ? rows
        : undefined;
    } finally {
      db.close();
    }
  }, "explicit acknowledgment");
  const sessions = await api("/session");
  const children = sessions.filter((s: any) => s.parentID === parent.id);
  assert.equal(children.length, 1);
  const release = (await client.request({
    op: "dispatch",
    input: { action: "cancel", intentId: "native-probe" },
  })) as any;
  assert.equal(release.status, "released");
  const diagnostics = await client.request({
    op: "inspect",
    filter: { taskId: bound.taskId },
  });
  await waitFor(
    async () => (modelRequests.length >= 2 ? true : undefined),
    "model tool result",
  );
  const recorded = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        binary,
        root,
        parent: parent.id,
        children: children.map((s: any) => s.id),
        results,
        completed,
        attempts,
        acknowledged,
        release,
        diagnostics,
        modelRequests,
        toolCalls,
        memory: processMemory([host.pid, observer.launchedOwner!.pid!]),
        memoryRoles: { opencode: host.pid, owner: observer.launchedOwner!.pid },
        mixedHost: mixed ? { claudeBinary, requests: mixed.requests, calls: mixed.calls, result: claudeResult, deliveries: mixedDeliveries,
          taskSubmittedAt, taskCompletedAt, durationMs: taskCompletedAt - taskSubmittedAt,
          userPromptInvocations: 1, automaticOpenCodeWakes: true,
          limitation: "One explicit Claude user turn after question persisted; no Claude idle-wake claim. Scripted model endpoints exercise actual hosts, not reasoning quality." } : undefined,
        source: { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          diffSha256: gitDiffHash(),
          hashes: Object.fromEntries(["scripts/probe-opencode-dispatch.ts", "scripts/fixtures/mixed-claude.ts", "scripts/fixtures/runtime-mixed-question.ts", "dist/coordination/owner-cli.js"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
          opencodeVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
          claudeVersion: claudeBinary ? execFileSync(claudeBinary, ["--version"], { encoding: "utf8" }).trim() : undefined },
        recorded,
        limitations:
          "Installed OpenCode native child creation, plugin enrollment, autonomous inbox wake/context, shell.env-authenticated fenced result and release. Optional actual Claude peer uses one explicit user-turn invocation and native MCP tools. Local scripted model endpoints; no external inference or semantic reasoning claim. Provider usage and cost fields are fixture-derived placeholders, not measured tokens or billing.",
      },
      (_key, value) => {
        if (typeof value !== "string") return value;
        for (const token of tokens)
          value = value.replaceAll(token, "<lease-token>");
        return value;
      },
      2,
    ),
  );
  console.log(output);
} catch (error) {
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(
    output + ".failure.json",
    JSON.stringify(
      {
        root,
        error: String(error),
        modelRequests,
        claude: mixed ? { requests: mixed.requests, calls: mixed.calls, error: String(mixedError) } : undefined,
        events: existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "",
      },
      (_key, value) => {
        if (typeof value !== "string") return value;
        for (const token of tokens)
          value = value.replaceAll(token, "<lease-token>");
        return value;
      },
      2,
    ),
  );
  throw error;
} finally {
  await mixed?.close();
  client?.close();
  model.stop(true);
  host.kill();
  await host.exited;
  await stderr;
  if (observer.launchedOwner) {
    observer.launchedOwner.ref();
    const stopped = once(observer.launchedOwner, "exit");
    observer.launchedOwner.kill();
    await stopped;
  }
}
