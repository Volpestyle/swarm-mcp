import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { processMemory } from "./fixtures/process-memory";

const [output, binary] = process.argv.slice(2);
if (!output || !binary) throw new Error("Usage: probe-opencode-native.ts output.json opencode-binary");
const root = mkdtempSync(join(tmpdir(), "swarm-native-only-"));
const requests: any[] = [], calls: any[] = [];
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json();
  requests.push(body);
  if (requests.length > 8) return new Response("Fixture request budget exceeded", { status: 400 });
  const messages = JSON.stringify(body.messages);
  const child = messages.includes("native-child-fixture");
  const done = messages.includes("native-child-result");
  const tool = !child && !done ? { name: "task", arguments: JSON.stringify({
    description: "Run native fixture", prompt: "native-child-fixture: return the exact text native-child-result",
    subagent_type: "general",
  }) } : undefined;
  if (tool) calls.push(tool);
  const chunks = tool ? [
    { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_native", type: "function", function: tool }] }, finish_reason: null },
    { delta: {}, finish_reason: "tool_calls" },
  ] : [
    { delta: { role: "assistant", content: child ? "native-child-result" : "Native delegation complete" }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ];
  return new Response(chunks.map(choice => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "probe", choices: [choice] })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
} });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SWARM_|OPENCODE_)/.test(key)));
Object.assign(env, {
  OPENCODE_DB: join(root, "host.db"), OPENCODE_TEST_HOME: join(root, "home"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], mcp: {}, enabled_providers: ["fixture"],
    model: "fixture/probe", small_model: "fixture/probe", permission: { task: "allow" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local fixture",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "fixture" },
      models: { probe: { name: "probe", limit: { context: 32768, output: 1024 } } } } },
    agent: { title: { disable: true }, summary: { disable: true } },
  }),
});
const host = Bun.spawn({ cmd: [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], cwd: root, env, stdout: "pipe", stderr: "pipe" });
const stderr = new Response(host.stderr).text();
const deadline = setTimeout(() => host.kill(), 120000);
try {
  let text = "", base = "";
  for await (const chunk of host.stdout) {
    text += new TextDecoder().decode(chunk);
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) { base = match[0]; break; }
  }
  assert.ok(base, "Host did not start");
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const parent = await api("/session", { title: "Native-only comparison" });
  const startedAt = Date.now();
  const result = await api(`/session/${parent.id}/message`, {
    model: { providerID: "fixture", modelID: "probe" }, agent: "build",
    parts: [{ type: "text", text: "Delegate the fixture once to your general subagent, then report completion." }],
  });
  const finishedAt = Date.now();
  const sessions = await api("/session");
  const children = sessions.filter((session: any) => session.parentID === parent.id);
  assert.equal(children.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes("<task_result>")), "Parent did not observe native task result");
  const childMessages = await api(`/session/${children[0].id}/message`);
  assert.ok(JSON.stringify(childMessages).includes("native-child-result"));
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify({ root, binary,
    version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    startedAt, finishedAt, durationMs: finishedAt-startedAt,
    userPromptInvocations: 1, swarmConfigured: false, coordinatorStarted: false,
    parent: parent.id, children: children.map((c: any) => c.id), result, childMessages,
    modelRequests: requests, toolCalls: calls,
    memory: processMemory([host.pid]),
    limitations: "Installed OpenCode native task tool and general child, no Swarm plugin/MCP/owner. Local scripted model, no inference-quality claim. Native host session history is retained; this fixture does not provide Swarm durable message acknowledgments, fenced attempts, cross-host identity or restart recovery. Task and timing differ from mixed-host fixtures; not an equal-semantics speed ratio.",
  }, null, 2));
  console.log(output);
} catch (error) {
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output + ".failure.json", JSON.stringify({ root, error: String(error), modelRequests: requests, toolCalls: calls }, null, 2));
  throw error;
} finally { clearTimeout(deadline); host.kill(); await host.exited; await stderr; model.stop(true); }
