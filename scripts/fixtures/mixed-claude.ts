import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { prepareClaudeLaunch } from "../../src/coordination/claude-launcher";

/** Actual Claude host, deterministic local model; never calls an external model. */
export async function mixedClaude(
  options: Omit<Parameters<typeof prepareClaudeLaunch>[0], "hostSessionId" | "incarnation" | "hookPath">,
  executable: string,
  tokens: Set<string>,
) {
  const recipient = await prepareClaudeLaunch({ ...options,
    hostSessionId: randomUUID(), incarnation: randomUUID(),
    hookPath: resolve("dist/coordination/claude-hook-cli.js"),
    clientPath: resolve("dist/coordination/client-cli.js"),
    mcpPath: resolve("dist/coordination/mcp-cli.js"),
  });
  const requests: any[] = [], calls: any[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let lease: any;
  let step = 0;
  const strings = (value: any): string[] => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 100 });
      if (!new URL(request.url).pathname.endsWith("/messages"))
        return new Response("Fixture route unavailable", { status: 404 });
      const body = await request.json();
      requests.push({ at: Date.now(), body });
      if (requests.length > 5) return new Response("Fixture budget exceeded", { status: 400 });
      for (const line of strings(body.messages).flatMap(s => s.split(/\r?\n/))) {
        try {
          const candidate = JSON.parse(line);
          if (candidate.message?.kind === "question" && candidate.leaseToken) {
            lease = candidate;
            tokens.add(candidate.leaseToken);
          }
        } catch { /* Native context includes prose and JSON lines. */ }
      }
      if (!lease) return new Response("Native hook omitted peer question", { status: 400 });
      let tool: { name: string; input: any } | undefined;
      if (step === 0) tool = { name: "mcp__swarm__swarm_send", input: {
        commandId: `mixed-reply-${lease.message.id}`, recipient: lease.message.sender,
        kind: "completion_notice", body: lease.message.body,
        threadId: JSON.parse(lease.message.body).taskId,
        taskId: JSON.parse(lease.message.body).taskId,
      } };
      if (step === 1) tool = { name: "mcp__swarm__swarm_inbox", input: {
        commandId: `mixed-ack-${lease.message.id}`, action: "ack",
        messageId: lease.message.id, leaseToken: lease.leaseToken,
      } };
      step++;
      if (tool) calls.push({ at: Date.now(), ...tool });
      const block = tool ? { type: "tool_use", id: `toolu_mixed_${step}`, ...tool }
        : { type: "text", text: "Peer reply sent and question acknowledged." };
      const stop = tool ? "tool_use" : "end_turn";
      const message = { id: `msg_mixed_${step}`, type: "message", role: "assistant",
        model: body.model, content: [block], stop_reason: stop, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 } };
      if (!body.stream) return Response.json(message);
      const events = [
        ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
        ["content_block_start", { type: "content_block_start", index: 0,
          content_block: tool ? { ...block, input: {} } : { ...block, text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0,
          delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) }
            : { type: "text_delta", text: "Peer reply sent and question acknowledged." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SWARM_|CLAUDE|ANTHROPIC|HERDR)/i.test(key)));
  Object.assign(env, recipient.environment, {
    CLAUDE_CONFIG_DIR: join(options.identity.directory, "claude-config"),
    ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""), ANTHROPIC_API_KEY: "fixture-only",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  });
  return {
    actor: recipient.actor, requests, calls,
    async launch() {
      const startedAt = Date.now();
      child = Bun.spawn({ cmd: [executable, "-p", "Handle the local peer fixture.",
        ...recipient.arguments, "--setting-sources", "", "--strict-mcp-config",
        "--tools", "Bash", "--allowedTools", "mcp__swarm__swarm_send", "mcp__swarm__swarm_inbox",
        "--model", "claude-sonnet-4-6", "--output-format", "json"],
        cwd: options.identity.directory, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => child?.kill(), 90000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (exitCode) throw new Error(`Claude fixture exit ${exitCode}: ${stderr}`);
        return { startedAt, finishedAt: Date.now(), exitCode, stdout, stderr, userPromptInvocations: 1 };
      } finally { clearTimeout(timer); }
    },
    async close() { child?.kill(); if (child) await child.exited; server.stop(true); },
  };
}
