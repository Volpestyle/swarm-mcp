import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, link, unlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CoordinationError } from "./errors";
import { artifactFiles, DEFAULT_STORAGE } from "./storage";

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export type CapturedArtifact = { digest: string; bytes: number };
/** Immutable blobs live beside the coordinator database, outside inboxes/KV.
 * Capture/publish completes before metadata commits; a crash can leave an orphan
 * blob, never a committed reference to a partially written one. */
export class ArtifactFiles {
  readonly root: string;
  private activeCaptures = 0;
  private reservedBytes = 0;
  private readonly verified = new Map<string, string>();
  constructor(databasePath: string, private readonly maximumBytes = DEFAULT_STORAGE.artifactBytes) {
    this.root = resolve(databasePath + ".artifacts");
  }
  path(scope: string, digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new CoordinationError("invalid_input", "Invalid artifact digest");
    return join(
      this.root,
      createHash("sha256").update(scope).digest("hex"),
      digest,
    );
  }
  async capture(scope: string, source: string | Buffer): Promise<CapturedArtifact> {
    if (this.activeCaptures >= 4)
      throw new CoordinationError(
        "overloaded",
        "At most four artifact captures may run concurrently",
      );
    this.activeCaptures++;
    try {
      return await this.captureFile(scope, source);
    } finally {
      this.activeCaptures--;
    }
  }
  private async captureFile(
    scope: string,
    source: string | Buffer,
  ): Promise<CapturedArtifact> {
    const directory = join(
      this.root,
      createHash("sha256").update(scope).digest("hex"),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.capture-${randomUUID()}`);
    const input = typeof source === "string" ? await open(source, "r") : undefined;
    let output: Awaited<ReturnType<typeof open>> | undefined;
    let reserved = 0;
    try {
      const before = await input?.stat({ bigint: true });
      if (before && (!before.isFile() || before.size > BigInt(MAX_ARTIFACT_BYTES)))
        throw new CoordinationError(
          "artifact_too_large",
          "Artifact must be a regular file no larger than 64 MiB",
        );
      const required = before ? Number(before.size) : (source as Buffer).length;
      if (required > MAX_ARTIFACT_BYTES)
        throw new CoordinationError("artifact_too_large", "Artifact must be no larger than 64 MiB");
      const used = artifactFiles(this.root).reduce((sum, file) => sum + file.bytes, 0);
      if (used + this.reservedBytes + required > this.maximumBytes) {
        throw new CoordinationError("storage_full", "Artifact limit reached; run offline maintenance or raise the limit");
      }
      reserved = required;
      this.reservedBytes += reserved;
      output = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      let bytes = 0;
      if (Buffer.isBuffer(source)) {
        hash.update(source);
        bytes = source.length;
        await output.writeFile(source);
      }
      while (input) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > reserved)
          throw new CoordinationError(
            "artifact_too_large",
            "Artifact grew beyond 64 MiB",
          );
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      const after = await input?.stat({ bigint: true });
      if (
        before && after && (before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        BigInt(bytes) !== after.size)
      )
        throw new CoordinationError(
          "artifact_changed",
          "Source changed during capture; retry after the writer finishes",
        );
      await output.sync();
      await output.close();
      output = undefined;
      const digest = hash.digest("hex"),
        destination = this.path(scope, digest);
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await this.digest(destination)) !== digest)
          throw new CoordinationError(
            "artifact_corrupt",
            "Existing content-addressed blob failed verification",
          );
      }
      // Persist the directory entry where the platform permits directory fsync.
      if (process.platform !== "win32") {
        const dir = await open(directory, "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      return { digest, bytes };
    } finally {
      this.reservedBytes -= reserved;
      await output?.close();
      await input?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  private async digest(path: string) {
    const file = await open(path, "r");
    try {
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      let total = 0;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_ARTIFACT_BYTES)
          throw new CoordinationError(
            "artifact_corrupt",
            "Stored artifact exceeds size limit",
          );
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest("hex");
    } finally {
      await file.close();
    }
  }
  async inspect(scope: string, artifact: CapturedArtifact, verify = false) {
    const path = this.path(scope, artifact.digest);
    try {
      const info = await stat(path, { bigint: true });
      if (!info.isFile() || info.size !== BigInt(artifact.bytes))
        return "corrupt" as const;
      if (verify) {
        const stamp = (row: typeof info) =>
          [row.dev, row.ino, row.size, row.mtimeNs, row.ctimeNs].join(":");
        const before = stamp(info);
        if (this.verified.get(path) !== before) {
          if (
            (await this.digest(path)) !== artifact.digest ||
            stamp(await stat(path, { bigint: true })) !== before
          )
            return "corrupt" as const;
          this.verified.set(path, before);
          if (this.verified.size > 256)
            this.verified.delete(this.verified.keys().next().value!);
        }
      }
      return "available" as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return "missing" as const;
      throw error;
    }
  }
  async read(
    scope: string,
    artifact: CapturedArtifact,
    offset = 0,
    limit = 32768,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > artifact.bytes ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65536
    )
      throw new CoordinationError(
        "invalid_input",
        "Invalid artifact byte cursor or page limit",
      );
    const status = await this.inspect(scope, artifact, true);
    if (status !== "available")
      return { status, offset, nextOffset: offset, data: null };
    const file = await open(this.path(scope, artifact.digest), "r");
    try {
      const buffer = Buffer.alloc(Math.min(limit, artifact.bytes - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      return {
        status,
        offset,
        nextOffset: offset + bytesRead,
        data: buffer.subarray(0, bytesRead).toString("base64"),
      };
    } finally {
      await file.close();
    }
  }
}
