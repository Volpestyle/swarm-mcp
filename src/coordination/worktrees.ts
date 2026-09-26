import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { CoordinationError, requireText } from "./errors";

export type Worktree = { root: string; repository: string };
const fold = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
export function within(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith("..\\") &&
      !rel.startsWith("../"))
  );
}

/** Resolve symlinked ancestors even for a not-yet-created file. A dangling
 * symlink is an error, not a missing ordinary path that may be reserved. */
export function canonicalPath(input: string): string {
  requireText(input, "path", 4096);
  let parent = resolve(input);
  const tail: string[] = [];
  while (true) {
    try {
      lstatSync(parent);
      return fold(join(realpathSync.native(parent), ...tail.reverse()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // If lstat succeeds but realpath failed this is a dangling link.
      try {
        if (lstatSync(parent).isSymbolicLink())
          throw new CoordinationError(
            "invalid_path",
            "Dangling symlinks cannot be reserved",
          );
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== "ENOENT") throw check;
      }
      const next = dirname(parent);
      if (next === parent)
        throw new CoordinationError(
          "invalid_path",
          "No existing path ancestor",
        );
      tail.push(basename(parent));
      parent = next;
    }
  }
}

/** Git discovery occurs before the database transaction, never while holding
 * its writer lock. Commands are argument arrays with bounded execution. */
export function discoverWorktree(directory: string): Worktree {
  const cwd = realpathSync.native(directory);
  const git = (flag: string) =>
    execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", flag],
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  return {
    root: canonicalPath(git("--show-toplevel")),
    repository: canonicalPath(git("--git-common-dir")),
  };
}

export function mapWorktreeFile(worktree: Worktree, input: string) {
  requireText(input, "file path", 4096);
  const root = canonicalPath(worktree.root);
  const physical = canonicalPath(resolve(root, input));
  if (!within(root, physical) || physical === root)
    throw new CoordinationError(
      "invalid_path",
      "File reservation must stay inside its worktree",
    );
  const logical = relative(root, physical).replaceAll("\\", "/");
  if (
    logical === ".git" ||
    logical.startsWith(".git/") ||
    (process.platform === "win32" && logical.includes(":"))
  )
    throw new CoordinationError(
      "invalid_path",
      "Git metadata and alternate data streams require a separate integration operation",
    );
  try {
    if (statSync(physical).isDirectory())
      throw new CoordinationError(
        "invalid_path",
        "Reserve concrete files, not directories",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    physical,
    logical,
    repository: canonicalPath(worktree.repository),
    worktree: root,
  };
}

/** Owner-configured identities. Repository paths are canonical git-common-dir,
 * not prefixes; membership is refreshed before each dispatch. */
export type ExecutionWorkspace = { kind: "repository" | "directory"; path: string };
export function executionWorktrees(workspaces: readonly ExecutionWorkspace[]) {
  const result = new Set<string>();
  const staleWorkspaces: ExecutionWorkspace[] = [];
  for (const entry of workspaces) {
    try {
      if (entry.kind === "directory") {
        if (!statSync(entry.path).isDirectory()) throw new Error("Not a directory");
        result.add(canonicalPath(entry.path));
        continue;
      }
      const repository = canonicalPath(entry.path);
      const output = execFileSync("git", ["--git-dir", repository, "worktree", "list", "--porcelain", "-z"], {
        encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      for (const field of output.split("\0")) {
        if (!field.startsWith("worktree ")) continue;
        const directory = field.slice(9);
        try {
          const found = discoverWorktree(directory);
          if (found.repository === repository) result.add(found.root);
        } catch { /* Pruned, missing or replaced checkouts confer no execution authority. */ }
      }
    } catch { staleWorkspaces.push(entry); }
  }
  return { worktrees: [...result].sort(), staleWorkspaces };
}
