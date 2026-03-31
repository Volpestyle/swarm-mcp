import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { file } from "./paths";

function normalizeForExpectation(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

test("file resolves relative and worktree absolute paths against a canonical file_root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "swarm-paths-test-"));
  const liveRepo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const liveApp = path.join(liveRepo, "packages", "app");
  const worktreeApp = path.join(worktree, "packages", "app");

  mkdirSync(path.join(liveRepo, ".git"), { recursive: true });
  mkdirSync(path.join(worktree, ".git"), { recursive: true });
  mkdirSync(liveApp, { recursive: true });
  mkdirSync(worktreeApp, { recursive: true });

  try {
    expect(
      file(worktreeApp, "src/index.ts", {
        fileRoot: liveApp,
        root: worktree
      })
    ).toBe(normalizeForExpectation(path.resolve(liveApp, "src/index.ts")));

    expect(
      file(path.join(worktree, "packages", "app"), path.join(worktree, "packages", "lib", "util.ts"), {
        fileRoot: liveApp,
        root: worktree
      })
    ).toBe(normalizeForExpectation(path.resolve(liveRepo, "packages", "lib", "util.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
