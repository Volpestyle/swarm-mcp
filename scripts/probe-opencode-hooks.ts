import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeWake } from "../src/coordination/opencode-wake";
import { CoordinationClient } from "../src/coordination/ipc";
import { Database } from "bun:sqlite";
import { build } from "esbuild";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { strict as assert } from "node:assert";

// Exercise installed host lifecycle without inference, user config changes or
// terminal injection. The server and all its persistent paths are disposable.
const binary =
  process.argv[3] ??
  (process.platform === "win32" ? undefined : Bun.which("opencode"));
if (!binary)
  throw new Error(
    "Pass the native OpenCode binary as the second argument (Windows package shims spawn an unowned child)",
  );
const output = process.argv[2];
if (!output)
  throw new Error("Usage: bun scripts/probe-opencode-hooks.ts output.json");
const root = mkdtempSync(join(tmpdir(), "swarm-opencode-probe-"));
const events = join(root, "events.jsonl");
const shellBarrier = join(root, "shell-barrier");
let firstModelRequestAt: number | undefined;
const readTarget = join(root, "fixture.txt");
writeFileSync(readTarget, "harmless tool fixture\n");
const ackProbe = resolve("dist/test/runtime-ack-probe.mjs");
let observedLeaseState: string | undefined;
const leaseTokens = new Set<string>();
const modelRequests: Array<{
  messages: Array<{ role: string; content?: unknown }>;
  tools?: unknown[];
}> = [];
const modelServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Unexpected route", { status: 404 });
    const body = (await request.json()) as (typeof modelRequests)[number];
    firstModelRequestAt ??= Date.now();
    modelRequests.push(body);
    if (modelRequests.length > 6)
      return new Response("Fixture request budget exceeded", { status: 400 });
    const hasResult = body.messages.some(
      (message) =>
        message.role === "tool" &&
        JSON.stringify(message.content).includes("harmless tool fixture"),
    );
    const acknowledged = body.messages.some(
      (message) =>
        message.role === "tool" &&
        JSON.stringify(message.content).includes("swarm-fixture-acknowledged"),
    );
    let toolCall;
    if (hasResult && !acknowledged) {
      const received = body.messages.find(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("peer-message-fixture-7392"),
      );
      if (!received || typeof received.content !== "string")
        throw new Error("Missing peer envelope");
      const lease = JSON.parse(received.content.split("\n").at(-1)!);
      leaseTokens.add(lease.leaseToken);
      assert.ok(
        [lease.message.id, lease.leaseToken].every((value) =>
          /^[a-zA-Z0-9-]+$/.test(value),
        ),
      );
      const db = new Database(join(root, "private", "coordination.db"), {
        readonly: true,
      });
      try {
        observedLeaseState = (
          db
            .query("SELECT state FROM inbox_deliveries WHERE message_id=?")
            .get(lease.message.id) as { state: string }
        ).state;
      } finally {
        db.close();
      }
      toolCall = {
        name: "bash",
        arguments: JSON.stringify({
          command:
            'node "' +
            ackProbe.replaceAll("\\", "/") +
            '" ' +
            lease.message.id +
            " " +
            lease.leaseToken,
          description: "Acknowledge processed fixture message",
        }),
      };
    } else if (!hasResult) {
      toolCall = {
        name: "read",
        arguments: JSON.stringify({ filePath: readTarget }),
      };
    }
    const chunks = toolCall
      ? [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: hasResult ? "call_fixture_ack" : "call_fixture_read",
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
            delta: { role: "assistant", content: "fixture complete" },
            finish_reason: null,
          },
          { delta: {}, finish_reason: "stop" },
        ];
    const payload =
      chunks
        .map(
          (choice) =>
            "data: " +
            JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe",
              choices: [{ index: 0, ...choice }],
            }) +
            "\n\n",
        )
        .join("") + "data: [DONE]\n\n";
    return new Response(payload, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
});
const plugin = join(root, "probe.mjs");
const lifecyclePath = resolve("dist/test/opencode-lifecycle.mjs");
await build({
  entryPoints: ["src/coordination/opencode-plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: lifecyclePath,
});
const shellProbe = resolve("dist/test/runtime-shell-probe.mjs");
await build({
  entryPoints: ["scripts/fixtures/runtime-shell-probe.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: shellProbe,
});
await build({
  entryPoints: ["scripts/fixtures/runtime-ack-probe.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: ackProbe,
});
const launcherOptions = {
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
const observer = await enrollRuntime({
  ...launcherOptions,
  host: "opencode",
  hostSessionId: "probe-observer",
  incarnation: "probe",
});
writeFileSync(
  plugin,
  `import { appendFileSync } from 'node:fs';
import { opencodeLifecycle, connectOpenCodeLifecycle } from ${JSON.stringify(pathToFileURL(lifecyclePath).href)};
export const Probe = async ({directory, client, serverUrl}) => {
  const record = event => appendFileSync(process.env.SWARM_PROBE_EVENTS, JSON.stringify(event)+'\\n');
  record({type:'plugin.loaded',directory});
  const hooks = opencodeLifecycle(${JSON.stringify(launcherOptions)}, event => record({ ...event, type: 'coordination.' + event.type }));
  let interrupted = false;
  let blockedSession;
  const faultClient = {session: client.session, event: {subscribe: async options => {
    const source = await client.event.subscribe(options);
    return {stream: (async function* () {
      for await (const event of source.stream) {
        yield event;
        if (event.type === 'permission.asked' && !interrupted) {
          interrupted = true;
          blockedSession = event.properties.sessionID;
          record({type: 'fixture.stream.ended'});
          return;
        }
      }
    })()};
  }}};
  const observedHooks = {...hooks, event: async input => {
    await hooks.event(input);
    if (input.event.type === 'swarm.snapshot.ready' && blockedSession) record({type: 'availability.recovered', hostSessionId: blockedSession, state: hooks.observe(blockedSession).state});
    const id = input.event.properties?.sessionID;
    if (id && (input.event.type === 'session.status' || input.event.type.startsWith('permission.'))) record({type: 'availability.' + hooks.observe(id).state, hostSessionId: id, evidence: hooks.observe(id).evidence});
  }};
  connectOpenCodeLifecycle({directory, client: faultClient, serverUrl}, observedHooks, state => record({type: 'observer.' + state}));
  return {...hooks, event: async (input) => { record(input.event); }};
};`,
);
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_CONFIG_DIR: join(root, "config"),
  OPENCODE_DB: join(root, "host.db"),
  OPENCODE_TEST_HOME: join(root, "home"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  SWARM_PROBE_EVENTS: events,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    plugin: [pathToFileURL(plugin).href],
    enabled_providers: ["fixture"],
    permission: { read: "ask" },
    model: "fixture/probe",
    small_model: "fixture/probe",
    provider: {
      fixture: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local scripted probe",
        options: {
          baseURL: `http://127.0.0.1:${modelServer.port}/v1`,
          apiKey: "fixture",
        },
        models: {
          probe: { name: "probe", limit: { context: 32768, output: 1024 } },
        },
      },
    },
    agent: { title: { disable: true }, summary: { disable: true } },
  }),
};
// Do not inherit server authentication or an explicit external config path.
for (const key of Object.keys(env)) {
  if (key.startsWith("SWARM_") && key !== "SWARM_PROBE_EVENTS")
    delete (env as Record<string, string | undefined>)[key];
}
delete env.OPENCODE_CONFIG;
delete env.OPENCODE_SERVER_PASSWORD;
delete env.OPENCODE_SERVER_USERNAME;
const child = Bun.spawn({
  cmd: [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
  cwd: root,
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const stderr = new Response(child.stderr).text();
let stdout = "";
try {
  const ready = (async () => {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk);
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) return match[0];
    }
    throw new Error("Server exited before readiness: " + (await stderr));
  })();
  const base = await Promise.race([
    ready,
    delay(20000, undefined, { ref: false }).then(() => {
      throw new Error("Server readiness timeout");
    }),
  ]);
  const created = await fetch(base + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "swarm lifecycle probe" }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const session = (await created.json()) as { id: string };
  const waitFor = async (type: string, hostSessionId: string, count = 1) => {
    for (let i = 0; i < 150; i++) {
      const records = existsSync(events)
        ? readFileSync(events, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      if (records.some((e) => e.type === "coordination.error"))
        throw new Error("Lifecycle adapter reported an error");
      if (
        records.filter(
          (e) => e.type === type && e.hostSessionId === hostSessionId,
        ).length >= count
      )
        return;
      await delay(100);
    }
    throw new Error(`Missing ${type} for ${hostSessionId}`);
  };
  await waitFor("coordination.enrolled", session.id);
  const disposed = await fetch(base + "/instance/dispose", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(disposed.status, 200);
  const restored = await fetch(base + "/session", {
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(restored.status, 200);
  await waitFor("coordination.enrolled", session.id, 2);
  const shellPromise = fetch(base + "/session/" + session.id + "/shell", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: "build",
      model: { providerID: "probe", modelID: "no-inference" },
      command:
        'node "' +
        shellProbe.replaceAll("\\", "/") +
        '" "' +
        shellBarrier.replaceAll("\\", "/") +
        '"',
    }),
    signal: AbortSignal.timeout(20000),
  });
  for (let i = 0; i < 100 && !existsSync(shellBarrier + ".ready"); i++)
    await delay(50);
  assert.ok(
    existsSync(shellBarrier + ".ready"),
    "Shell must be running before queued prompt",
  );
  const busyResponse = await fetch(base + "/session/status", {
    signal: AbortSignal.timeout(5000),
  });
  const busy = (await busyResponse.json()) as Record<string, { type: string }>;
  assert.equal(busy[session.id].type, "busy");
  const enrollments = readFileSync(events, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event.type === "coordination.enrolled" &&
        event.hostSessionId === session.id,
    );
  let shellEvidence;
  const coordinator = await CoordinationClient.connect(
    observer.environment.SWARM_COORDINATOR_ENDPOINT,
    observer.environment.SWARM_SESSION_CAPABILITY,
  );
  let deliveryEvidence;
  try {
    const sent = (await coordinator.request({
      op: "command",
      command: {
        id: "post-tool-probe",
        type: "message.send",
        payload: {
          recipient: enrollments.at(-1).actor,
          kind: "question",
          body: "peer-message-fixture-7392",
        },
      },
    })) as { value: { messageId: string } };
    const api = createOpencodeClient({ baseUrl: base, directory: root });
    const wakeOptions = {
      api,
      request: (operation: import("../src/coordination/ipc").Operation) =>
        coordinator.request(operation),
      actor: enrollments.at(-1).actor,
      scope: observer.scope,
      hostSessionId: session.id,
      stateDirectory: launcherOptions.stateDirectory,
    };
    const wake = new OpenCodeWake(wakeOptions);
    assert.equal(
      (await wake.notify(sent.value.messageId)).status,
      "deferred",
      "Busy shell must defer wake",
    );
    const promptPromise = fetch(base + "/session/" + session.id + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "fixture", modelID: "probe" },
        parts: [{ type: "text", text: "Read fixture.txt once." }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    let promptPersisted = false;
    for (let i = 0; i < 100; i++) {
      const records = readFileSync(events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      promptPersisted = records.some(
        (event) =>
          event.type === "message.part.updated" &&
          event.properties.part?.text === "Read fixture.txt once.",
      );
      if (promptPersisted) break;
      await delay(25);
    }
    assert.ok(
      promptPersisted,
      "Host must persist queued prompt while shell remains active",
    );
    assert.equal(
      modelRequests.length,
      0,
      "Queued prompt must not interrupt the shell",
    );
    writeFileSync(shellBarrier + ".release", "release");
    const shellResponse = await shellPromise;
    assert.equal(shellResponse.status, 200, await shellResponse.clone().text());
    const shellResult = (await shellResponse.json()) as {
      parts: Array<{ type: string; state?: { output?: string } }>;
    };
    const shellOutput =
      shellResult.parts.find((part) => part.type === "tool")?.state?.output ??
      "";
    shellEvidence = JSON.parse(shellOutput.trim());
    assert.equal(shellEvidence.marker, "swarm-shell-probe");
    assert.equal(shellEvidence.snapshot.actor, enrollments.at(-1).actor);
    assert.equal(shellEvidence.snapshot.scope, observer.scope);
    assert.deepEqual(shellEvidence.keys, [
      "SWARM_COORDINATOR_ENDPOINT",
      "SWARM_PROBE_EVENTS",
      "SWARM_SESSION_CAPABILITY",
    ]);
    await waitFor("availability.blocked", session.id);
    await waitFor("availability.recovered", session.id);
    const recovered = readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "availability.recovered");
    assert.equal(recovered.state, "blocked");
    const blockedStatus = (await coordinator.request({
      op: "message_status",
      messageId: sent.value.messageId,
    })) as { deliveries: Array<{ state: string }> };
    assert.equal(
      blockedStatus.deliveries[0].state,
      "pending",
      "Permission wait must not consume inbox",
    );
    const asked = readFileSync(events, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find(
        (event) =>
          event.type === "permission.asked" &&
          event.properties.sessionID === session.id,
      );
    assert.ok(asked);
    const reply = await fetch(
      base + "/session/" + session.id + "/permissions/" + asked.properties.id,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "once" }),
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.equal(reply.status, 200);
    const prompt = await promptPromise;
    assert.equal(prompt.status, 200);
    const promptResult = await prompt.text();
    const received = modelRequests
      .flatMap((request) => request.messages)
      .filter(
        (message) =>
          message.role === "tool" &&
          JSON.stringify(message.content).includes("peer-message-fixture-7392"),
      );
    assert.ok(
      received.length > 0,
      "Peer envelope absent from model tool result: " +
        promptResult.slice(0, 1000),
    );
    const status = (await coordinator.request({
      op: "message_status",
      messageId: sent.value.messageId,
    })) as { deliveries: Array<{ state: string }> };
    assert.equal(
      observedLeaseState,
      "leased",
      "Host admission must not acknowledge processing",
    );
    assert.equal(
      status.deliveries[0].state,
      "acknowledged",
      "Explicit host tool must acknowledge processing",
    );
    assert.equal(
      modelRequests.length,
      3,
      "Read, acknowledgment, then completion",
    );
    assert.ok(
      firstModelRequestAt! >=
        Number(readFileSync(shellBarrier + ".completed", "utf8")),
    );
    const next = (await coordinator.request({
      op: "command",
      command: {
        id: "wake-probe",
        type: "message.send",
        payload: {
          recipient: wakeOptions.actor,
          kind: "question",
          body: "wake-only-fixture",
        },
      },
    })) as { value: { messageId: string } };
    const [wakeA, wakeB] = await Promise.all([
      wake.notify(next.value.messageId),
      wake.notify(next.value.messageId),
    ]);
    assert.equal(wakeA.status, "accepted");
    assert.deepEqual(wakeA, wakeB);
    for (let i = 0; i < 100; i++) {
      const status = await api.session.status(
        {},
        { throwOnError: true, signal: AbortSignal.timeout(2000) },
      );
      if (modelRequests.length === 4 && !status.data[session.id]) break;
      await delay(25);
    }
    assert.equal(
      modelRequests.length,
      4,
      "Coalesced wake starts one additional model request",
    );
    const replay = await new OpenCodeWake(wakeOptions).notify(
      next.value.messageId,
    );
    assert.equal(replay.status, "accepted");
    assert.equal(replay.messageId, wakeA.messageId);
    const retained = await api.session.message(
      { sessionID: session.id, messageID: wakeA.messageId! },
      { throwOnError: true },
    );
    assert.equal(retained.data.info.id, wakeA.messageId);
    const pendingWake = (await coordinator.request({
      op: "message_status",
      messageId: next.value.messageId,
    })) as { deliveries: Array<{ state: string }> };
    assert.equal(
      pendingWake.deliveries[0].state,
      "pending",
      "Wake is not consumption or acknowledgment",
    );
    deliveryEvidence = {
      wake: {
        busyDeferred: true,
        coalescedRequests: 2,
        modelRequests: 1,
        replayedMessageId: replay.messageId,
        inboxState: pendingWake.deliveries[0].state,
      },
      promptQueuedWhileBusy: true,
      modelWaitedForShell:
        firstModelRequestAt! >=
        Number(readFileSync(shellBarrier + ".completed", "utf8")),
      scriptedLocalModel: true,
      requests: modelRequests.length,
      toolResultReachedModel: true,
      messageId: sent.value.messageId,
      stateRecoveredAfterAutomaticReconnect: recovered.state,
      stateWhilePermissionBlocked: blockedStatus.deliveries[0].state,
      stateAfterAdmission: observedLeaseState,
      stateAfterExplicitAck: status.deliveries[0].state,
    };
  } finally {
    coordinator.close();
  }
  const removed = await fetch(base + "/session/" + session.id, {
    method: "DELETE",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(removed.status, 200, await removed.clone().text());
  const warm = await fetch(base + "/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "warm lifecycle probe" }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(warm.status, 200);
  const warmSession = (await warm.json()) as { id: string };
  await waitFor("coordination.enrolled", warmSession.id);
  const warmRemoved = await fetch(base + "/session/" + warmSession.id, {
    method: "DELETE",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(warmRemoved.status, 200);
  await waitFor("coordination.closed", session.id);
  await waitFor("coordination.closed", warmSession.id);
  let recorded: Array<{ type: string }> = [];
  for (let i = 0; i < 50; i++) {
    if (existsSync(events))
      recorded = readFileSync(events, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    if (
      recorded.filter((event) => event.type === "session.deleted").length === 2
    )
      break;
    await delay(100);
  }
  for (const type of ["plugin.loaded", "session.updated", "session.deleted"])
    assert.ok(
      recorded.some((event) => event.type === type),
      `Missing real host event: ${type}`,
    );
  assert.equal(
    recorded.filter((event) => event.type === "observer.reconciled").length,
    3,
  );
  assert.equal(
    recorded.filter((event) => event.type === "observer.disconnected").length,
    2,
  );
  const db = new Database(join(root, "private", "coordination.db"), {
    readonly: true,
  });
  let coordinatorSessions;
  try {
    coordinatorSessions = db
      .query(
        "SELECT agent_id, generation, state FROM sessions WHERE agent_id != ? ORDER BY agent_id",
      )
      .all(observer.actor);
    assert.equal(
      coordinatorSessions.length,
      3,
      "One additional incarnation after host instance restart",
    );
    const rows = coordinatorSessions as Array<{
      agent_id: string;
      state: string;
      generation: number;
    }>;
    assert.equal(
      new Set(rows.map((row) => row.agent_id)).size,
      2,
      "Stable actors across restart",
    );
    assert.deepEqual(
      rows.map((row) => `${row.generation}:${row.state}`).sort(),
      ["1:closed", "1:superseded", "2:closed"],
    );
  } finally {
    db.close();
  }
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        binary,
        root,
        sessions: [session.id, warmSession.id],
        coordinatorSessions,
        shellEvidence,
        deliveryEvidence,
        createdEvents: recorded.filter(
          (event) => event.type === "session.created",
        ).length,
        recorded,
        limitations:
          "Actual host plugin load, Subscription-first enrollment, instance restart reconciliation with stable actor and fenced generation, and close for two native sessions. Missing session.created is recorded, not assumed supported. Actual shell.env capability authenticated by child bootstrap. Real host tools and model-request assembly verified using a local scripted OpenAI-compatible endpoint; no external model inference or semantic understanding claimed. Reservation denial, idle wakeup and restart delivery deduplication remain unproven.",
      },
      (_key, value) => {
        if (typeof value !== "string") return value;
        for (const token of leaseTokens)
          value = value.replaceAll(token, "<lease-token>");
        return value;
      },
      2,
    ),
  );
  console.log(output);
} finally {
  modelServer.stop(true);
  child.kill();
  await child.exited;
  await stderr;
  if (observer.launchedOwner) {
    observer.launchedOwner.ref();
    const exited = once(observer.launchedOwner, "exit");
    observer.launchedOwner.kill();
    await exited;
  }
}
