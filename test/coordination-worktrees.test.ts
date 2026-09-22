import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPath,
  discoverWorktree,
  mapWorktreeFile,
} from "../src/coordination/worktrees";

test("real Git worktrees share logical mapping while retaining separate physical files", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-worktrees-")),
    main = join(root, "main"),
    peer = join(root, "peer");
  mkdirSync(main);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", main, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init");
  writeFileSync(join(main, "shared.txt"), "initial\n");
  git("add", "shared.txt");
  git(
    "-c",
    "user.name=Swarm Test",
    "-c",
    "user.email=swarm-test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  git("worktree", "add", "-b", "peer", peer);
  const mainTree = discoverWorktree(main),
    peerTree = discoverWorktree(peer);
  const a = mapWorktreeFile(mainTree, "shared.txt"),
    b = mapWorktreeFile(peerTree, "shared.txt");
  expect(a.physical).not.toBe(b.physical);
  expect(a.repository).toBe(b.repository);
  expect(a.logical).toBe(b.logical);
  expect(mapWorktreeFile(mainTree, join(main, "shared.txt"))).toEqual(a);
  if (process.platform === "win32")
    expect(mapWorktreeFile(mainTree, "SHARED.TXT").physical).toBe(a.physical);
}, 20000);

test("new files resolve ancestor links and reject symlink escape and Git metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "swarm-paths-")),
    actual = join(root, "actual"),
    alias = join(root, "alias"),
    outside = mkdtempSync(join(tmpdir(), "swarm-outside-"));
  mkdirSync(actual);
  symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  expect(canonicalPath(join(alias, "new", "file.txt"))).toBe(
    canonicalPath(join(actual, "new", "file.txt")),
  );
  symlinkSync(
    outside,
    join(root, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const tree = { root, repository: root };
  expect(() => mapWorktreeFile(tree, "escape/file.txt")).toThrow(
    "inside its worktree",
  );
  expect(() => mapWorktreeFile(tree, "../outside.txt")).toThrow(
    "inside its worktree",
  );
  expect(() => mapWorktreeFile(tree, ".git/index")).toThrow("Git metadata");
  expect(() => mapWorktreeFile(tree, "actual")).toThrow("concrete files");
});
