import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherForIdentity } from "../src/launcher_identity";

describe("launcher identity profile resolution", () => {
  test("target profile aliases win when the caller env belongs to another profile", () => {
    const profileDir = mkdtempSync(join(tmpdir(), "swarm-launcher-profiles-"));
    writeFileSync(join(profileDir, "personal.env"), "SWARM_HARNESS_CLAUDE=clowd\n");
    writeFileSync(join(profileDir, "work.env"), "SWARM_HARNESS_CLAUDE=clawd\n");

    expect(
      launcherForIdentity("claude", "work", {
        AGENT_IDENTITY: "personal",
        SWARM_HARNESS_CLAUDE: "clowd",
        SWARM_MCP_PROFILE_DIR: profileDir,
      }),
    ).toBe("clawd");
  });
});
