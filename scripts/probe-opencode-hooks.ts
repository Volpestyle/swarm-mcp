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
const plugin = join(root, "probe.mjs");
writeFileSync(
  plugin,
  `import { appendFileSync } from 'node:fs';
export const Probe = async ({directory}) => {
  const record = event => appendFileSync(process.env.SWARM_PROBE_EVENTS, JSON.stringify(event)+'\\n');
  record({type:'plugin.loaded',directory});
  return {event: async ({event}) => record(event)};
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
    enabled_providers: [],
  }),
};
// Do not inherit server authentication or an explicit external config path.
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
  const warmRemoved = await fetch(base + "/session/" + warmSession.id, {
    method: "DELETE",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(warmRemoved.status, 200);
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
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        binary,
        root,
        sessions: [session.id, warmSession.id],
        createdEvents: recorded.filter(
          (event) => event.type === "session.created",
        ).length,
        recorded,
        limitations:
          "Actual host plugin load and two session create/delete operations only. Missing session.created is recorded, not assumed supported. No model invocation, tool-boundary delivery, reservation denial or wakeup proven.",
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  child.kill();
  await child.exited;
  await stderr;
}
