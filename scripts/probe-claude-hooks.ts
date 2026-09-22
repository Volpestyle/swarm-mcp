import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enrollRuntime } from "../src/coordination/runtime-launcher";
import { CoordinationClient } from "../src/coordination/ipc";
import { hasClaudeContext } from "../src/coordination/claude-context";
import { setTimeout as delay } from "node:timers/promises";

const capture = process.argv[2];
const executable = process.argv[3];
const expiryProbe = process.argv[4] === "--lease-expiry";
const restartProbe = process.argv[4] === "--restart";
if (!capture || !executable)
  throw new Error(
    "Usage: probe-claude-hooks <capture.json> <claude executable>",
  );
mkdirSync(resolve("dist/test"), { recursive: true });
const bundles = mkdtempSync(resolve("dist/test/claude-probe-"));
for (const [entry, file] of [
  ["src/coordination/owner-cli.ts", "owner.mjs"],
  ["src/coordination/claude-hook-cli.ts", "hook.mjs"],
  ["scripts/fixtures/runtime-ack-probe.ts", "ack.mjs"],
])
  await build({
    entryPoints: [entry!],
    outfile: join(bundles, file!),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
const root = mkdtempSync(join(tmpdir(), "swarm-claude-probe-"));
const sessionId = randomUUID();
const options = {
  stateDirectory: join(root, "private"),
  nodePath: Bun.which("node")!,
  ownerPath: join(bundles, "owner.mjs"),
  identity: {
    projectRoot: root,
    directory: root,
    fileRoot: root,
    profile: "fixture",
    allowedRoots: [root],
  },
  host: "claude-code" as const,
  incarnation: randomUUID(),
};
const sender = await enrollRuntime({
  ...options,
  hostSessionId: "fixture-sender",
});
let recipient = await enrollRuntime({ ...options, hostSessionId: sessionId });
const initialRecipient = recipient;
const client = await CoordinationClient.connect(
  sender.environment.SWARM_COORDINATOR_ENDPOINT,
  sender.environment.SWARM_SESSION_CAPABILITY,
);
let child: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  const sent: string[] = [];
  const send = async (body: string) => {
    const receipt = (await client.request({
      op: "command",
      command: {
        id: randomUUID(),
        type: "message.send",
        payload: { recipient: recipient.actor, kind: "question", body },
      },
    })) as { value: { messageId: string } };
    sent.push(receipt.value.messageId);
  };
  await send("claude-turn-start-fixture");
  let requests = 0;
  const seen: string[] = [];
  const envelopes: object[] = [];
  const beforeAck: string[] = [];
  const refreshed = new Set<string>();
  const observedTokens = new Set<string>();
  let replayedEnvelopes = 0;
  let contextAfterKill: boolean[] = [];
  let crashReady = false;
  let releaseCrash!: () => void;
  const crashBarrier = new Promise<void>((resolve) => {
    releaseCrash = resolve;
  });
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 100 });
      if (!url.pathname.endsWith("/messages"))
        return new Response("fixture route unavailable", { status: 404 });
      const body = await request.json();
      requests++;
      if (requests > 5) throw new Error("Model request budget exceeded");
      const leases = strings(body.messages)
        .flatMap((text) => text.split(/\r?\n/))
        .flatMap((line) => {
          try {
            const item = JSON.parse(line);
            return item.leaseToken && (item.message || item.messageId)
              ? [item]
              : [];
          } catch {
            return [];
          }
        });
      const original = leases.find(
        (item) => item.message && !observedTokens.has(item.leaseToken),
      );
      const renewal = leases.find(
        (item) =>
          !item.message && item.messageId && !refreshed.has(item.leaseToken),
      );
      const lease =
        original ??
        (renewal
          ? { ...renewal, message: { id: renewal.messageId } }
          : undefined);
      let content: unknown[];
      let stop = "end_turn";
      if (lease) {
        observedTokens.add(lease.leaseToken);
        if (original) {
          if (!seen.includes(lease.message.id)) {
            envelopes.push(lease.message);
            seen.push(lease.message.id);
          } else replayedEnvelopes++;
        } else refreshed.add(lease.leaseToken);
        const status = (await client.request({
          op: "message_status",
          messageId: lease.message.id,
        })) as { deliveries: Array<{ state: string }> };
        beforeAck.push(status.deliveries[0]!.state);
        if (requests === 1) await send("claude-post-tool-fixture");
        if (restartProbe && requests === 2) {
          // Let one assistant/tool exchange persist a resumable transcript.
          // Then kill the host before either delivery is acknowledged.
          crashReady = true;
          await crashBarrier;
          return new Response("fixture host terminated", { status: 503 });
        }
        stop = "tool_use";
        content = [
          {
            type: "tool_use",
            id: `toolu_fixture_${requests}`,
            name: "Bash",
            input: {
              command:
                restartProbe && requests === 1
                  ? "node --version"
                  : expiryProbe && requests === 1
                    ? 'node -e "setTimeout(()=>{},32000)"'
                    : `node "${join(bundles, "ack.mjs").replaceAll("\\", "/")}" ${lease.message.id} ${lease.leaseToken}`,
              description:
                "Acknowledge the fixture peer message through the coordinator",
            },
          },
        ];
      } else content = [{ type: "text", text: "fixture complete" }];
      const message = {
        id: `msg_fixture_${requests}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      };
      if (!body.stream) return Response.json(message);
      const events: Array<[string, unknown]> = [
        [
          "message_start",
          {
            type: "message_start",
            message: { ...message, content: [], stop_reason: null },
          },
        ],
      ];
      for (const [index, rawBlock] of content.entries()) {
        const block = rawBlock as {
          type: string;
          input?: unknown;
          text?: string;
        };
        events.push([
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block:
              block.type === "tool_use"
                ? { ...block, input: {} }
                : { ...block, text: "" },
          },
        ]);
        events.push([
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta:
              block.type === "tool_use"
                ? {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(block.input),
                  }
                : { type: "text_delta", text: block.text },
          },
        ]);
        events.push([
          "content_block_stop",
          { type: "content_block_stop", index },
        ]);
      }
      events.push([
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: { output_tokens: 20 },
        },
      ]);
      events.push(["message_stop", { type: "message_stop" }]);
      return new Response(
        events
          .map(
            ([event, data]) =>
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const hook = `node "${join(bundles, "hook.mjs").replaceAll("\\", "/")}"`;
  const settings = join(root, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd"].map(
          (event) => [
            event,
            [{ hooks: [{ type: "command", command: hook, timeout: 10 }] }],
          ],
        ),
      ),
    }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(SWARM_|CLAUDE|ANTHROPIC|HERDR)/i.test(key),
    ),
  );
  Object.assign(env, recipient.environment, {
    SWARM_NATIVE_SESSION_ID: sessionId,
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
    ANTHROPIC_API_KEY: "fixture-only",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  const launch = (resume: boolean) =>
    Bun.spawn({
      cmd: [
        executable,
        "-p",
        "Run the local fixture.",
        resume ? "--resume" : "--session-id",
        sessionId,
        "--settings",
        settings,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--tools",
        "Bash",
        "--allowedTools",
        "Bash",
        "--model",
        "claude-sonnet-4-6",
        "--output-format",
        "json",
      ],
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  child = launch(false);
  timeout = setTimeout(
    () => child?.kill(),
    // Restart includes two native startups, real lease expiry and shutdown.
    // This harness deadline does not change coordinator or hook deadlines.
    restartProbe ? 180000 : expiryProbe ? 120000 : 90000,
  );
  let terminatedExit: number | undefined;
  let fencedCode: string | undefined;
  if (restartProbe) {
    const deadline = Date.now() + 30000;
    while (!crashReady && Date.now() < deadline) await delay(20);
    if (!crashReady) {
      child.kill();
      await child.exited;
      const diagnostic = await new Response(child.stderr).text();
      writeFileSync(
        capture,
        JSON.stringify(
          {
            result: "failed",
            phase: "crash barrier",
            requests,
            seen: seen.length,
            beforeAck,
            stderrBytes: Buffer.byteLength(diagnostic),
          },
          null,
          2,
        ),
      );
      throw new Error("Host did not reach crash barrier");
    }
    const firstOutput = new Response(child.stdout).text();
    const firstError = new Response(child.stderr).text();
    child.kill(9);
    terminatedExit = await child.exited;
    releaseCrash();
    await Promise.all([firstOutput, firstError]);
    const savedTranscript = [
      ...new Bun.Glob("**/*.jsonl").scanSync({
        cwd: join(root, "claude-config"),
        absolute: true,
      }),
    ].find((path) => path.endsWith(`${sessionId}.jsonl`));
    if (savedTranscript)
      contextAfterKill = await Promise.all(
        envelopes.map((message) =>
          hasClaudeContext(
            savedTranscript,
            sessionId,
            message,
            AbortSignal.timeout(5000),
          ),
        ),
      );
    await delay(32000);
    recipient = await enrollRuntime({
      ...options,
      hostSessionId: sessionId,
      incarnation: randomUUID(),
    });
    const old = await CoordinationClient.connect(
      initialRecipient.environment.SWARM_COORDINATOR_ENDPOINT,
      initialRecipient.environment.SWARM_SESSION_CAPABILITY,
    );
    try {
      await old.request({ op: "bootstrap" });
    } catch (error) {
      fencedCode = (error as { code?: string }).code;
    } finally {
      old.close();
    }
    Object.assign(env, recipient.environment);
    child = launch(true);
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  const states = await Promise.all(
    sent.map(async (messageId) => {
      const status = (await client.request({
        op: "message_status",
        messageId,
      })) as { deliveries: Array<{ state: string }> };
      return status.deliveries[0]!.state;
    }),
  );
  const endedClient = await CoordinationClient.connect(
    recipient.environment.SWARM_COORDINATOR_ENDPOINT,
    recipient.environment.SWARM_SESSION_CAPABILITY,
  );
  let endedCode: string | undefined;
  try {
    await endedClient.request({ op: "bootstrap" });
  } catch (error) {
    endedCode = (error as { code?: string }).code;
  } finally {
    endedClient.close();
  }
  let hostResult: { subtype?: string; is_error?: boolean; num_turns?: number } =
    {};
  try {
    hostResult = JSON.parse(stdout);
  } catch {}
  const transcript = [
    ...new Bun.Glob("**/*.jsonl").scanSync({
      cwd: join(root, "claude-config"),
      absolute: true,
    }),
  ].find((path) => path.endsWith(`${sessionId}.jsonl`));
  const persistedContext = transcript
    ? await Promise.all(
        envelopes.map((message) =>
          hasClaudeContext(
            transcript,
            sessionId,
            message,
            AbortSignal.timeout(5000),
          ),
        ),
      )
    : [];
  const evidence = {
    host: "Claude Code",
    version: new TextDecoder()
      .decode(Bun.spawnSync([executable, "--version"]).stdout)
      .trim(),
    sessionId,
    exitCode,
    requests,
    sent: sent.length,
    seen: seen.length,
    beforeAck,
    states,
    hostResult: {
      subtype: hostResult.subtype,
      isError: hostResult.is_error,
      turns: hostResult.num_turns,
    },
    stderrBytes: Buffer.byteLength(stderr),
    endedCapabilityError: endedCode,
    persistedContext,
    leaseExpiryProbe: expiryProbe,
    restartProbe,
    restart: restartProbe
      ? {
          terminatedExit,
          sameActor: recipient.actor === initialRecipient.actor,
          initialGeneration: initialRecipient.generation,
          resumedGeneration: recipient.generation,
          oldCapabilityError: fencedCode,
          contextAfterKill,
          replayedEnvelopes,
        }
      : undefined,
    leaseRefreshes: refreshed.size,
    scriptedLocalModel: true,
  };
  // No hook input, model requests, capability or lease token is retained.
  writeFileSync(capture, JSON.stringify(evidence, null, 2) + "\n");
  if (
    exitCode !== 0 ||
    requests !== (restartProbe ? 5 : expiryProbe ? 4 : 3) ||
    seen.length !== 2 ||
    beforeAck.some((s) => s !== "leased") ||
    states.some((s) => s !== "acknowledged") ||
    endedCode !== "stale_session" ||
    persistedContext.length !== 2 ||
    persistedContext.some((found) => !found) ||
    (restartProbe
      ? refreshed.size !== contextAfterKill.filter(Boolean).length ||
        replayedEnvelopes !== contextAfterKill.filter((found) => !found).length
      : refreshed.size !== (expiryProbe ? 1 : 0)) ||
    (restartProbe &&
      (terminatedExit === 0 ||
        recipient.actor !== initialRecipient.actor ||
        recipient.generation !== initialRecipient.generation + 1 ||
        fencedCode !== "stale_session" ||
        contextAfterKill.length !== 2 ||
        !contextAfterKill[0]))
  )
    throw new Error(`Claude probe incomplete; inspect ${capture}`);
  console.log(capture);
} finally {
  if (timeout) clearTimeout(timeout);
  child?.kill();
  if (child) await child.exited;
  server?.stop(true);
  client.close();
  if (sender.launchedOwner) {
    sender.launchedOwner.ref();
    const exited = once(sender.launchedOwner, "exit");
    sender.launchedOwner.kill();
    await exited;
  }
}
