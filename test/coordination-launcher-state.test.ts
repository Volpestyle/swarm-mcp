import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentState, ownerState } from "../src/coordination/launcher-state";

test("concurrent private-state writers publish one complete owner and resume identity", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "swarm-private-")), "state");
  const results = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          resolve("test/fixtures/launcher-state-worker.ts"),
          root,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      return JSON.parse(stdout);
    }),
  );
  expect(new Set(results.map((result) => result.owner)).size).toBe(1);
  expect(new Set(results.map((result) => result.agent)).size).toBe(1);
  expect(
    readdirSync(root).filter((name) => name.startsWith(".pending")),
  ).toEqual([]);
  const first = agentState(root, "scope", "host", "session");
  expect(agentState(root, "scope", "host", "session")).toEqual(first);
  expect(agentState(root, "different", "host", "session").agentId).not.toBe(
    first.agentId,
  );
}, 20000);

test("malformed owner state is rejected without rotating credentials", () => {
  const root = join(
    mkdtempSync(join(tmpdir(), "swarm-private-corrupt-")),
    "state",
  );
  const initial = ownerState(root);
  writeFileSync(initial.configPath, "{partial");
  expect(() => ownerState(root)).toThrow();
  expect(readFileSync(initial.configPath, "utf8")).toBe("{partial");
}, 10000);

test("existing insecure state directories are refused without writing credentials", () => {
  const root = join(
    mkdtempSync(join(tmpdir(), "swarm-private-insecure-")),
    "state",
  );
  mkdirSync(root);
  if (process.platform === "win32")
    execFileSync("icacls.exe", [root, "/grant", "*S-1-1-0:(OI)(CI)RX"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else chmodSync(root, 0o755);
  expect(() => ownerState(root)).toThrow();
  expect(existsSync(join(root, "owner.json"))).toBe(false);
}, 10000);
