import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hash arbitrarily large tracked diffs without buffering child-process output. */
export function gitDiffHash(cwd = process.cwd()): string {
  const directory = mkdtempSync(join(tmpdir(), "swarm-source-"));
  let file: number | undefined;
  try {
    const path = join(directory, "diff");
    execFileSync("git", ["diff", "--no-ext-diff", `--output=${path}`, "HEAD", "--"],
      { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    file = openSync(path, "r");
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    let bytes: number;
    while ((bytes = readSync(file, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    if (file !== undefined) closeSync(file);
    rmSync(directory, { recursive: true, force: true });
  }
}
