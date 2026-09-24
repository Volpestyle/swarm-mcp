import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiffHash } from "../scripts/fixtures/source-state";

test("source fingerprint handles diffs larger than the subprocess buffer", () => {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-source-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  try {
    git("init", "--quiet");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(cwd, "file.txt"), "initial\n");
    git("add", "file.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
    expect(gitDiffHash(cwd)).toBe(createHash("sha256").digest("hex"));
    writeFileSync(join(cwd, "file.txt"), "changed line\n".repeat(120000));
    const diff = git("diff", "--no-ext-diff", "HEAD", "--");
    expect(diff.byteLength).toBeGreaterThan(1024 * 1024);
    const expected = createHash("sha256").update(diff).digest("hex");
    expect(gitDiffHash(cwd)).toBe(expected);
    git("add", "file.txt");
    expect(gitDiffHash(cwd)).toBe(expected);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
