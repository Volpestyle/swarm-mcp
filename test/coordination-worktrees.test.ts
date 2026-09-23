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

test("Windows 8.3 short-name spellings canonicalize to the long path", () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "swarm-shortname-")),
    name = "long-directory-name-for-short-alias",
    long = join(root, name);
  mkdirSync(long);
  const listing = execFileSync("cmd.exe", ["/c", "dir", "/x", root], {
    encoding: "utf8",
    windowsHide: true,
  });
  const short = listing
    .split(/\r?\n/)
    .map((line) => line.match(/\s(\S{1,8}~\d+)\s+(\S+)\s*$/))
    .find((match) => match?.[2] === name)?.[1];
  // Volumes with 8.3 name creation disabled cannot exercise this case.
  if (!short) return;
  expect(canonicalPath(join(root, short, "file.txt"))).toBe(
    canonicalPath(join(long, "file.txt")),
  );
});
