import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launcherForIdentity,
  profileEnvSuffix,
  profileScopedEnvName,
} from "../src/launcher_identity";

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

  test("free-form profile names normalize for env and launcher lookup", () => {
    const profileDir = mkdtempSync(join(tmpdir(), "swarm-launcher-freeform-"));
    writeFileSync(join(profileDir, "client-x.env"), "SWARM_HARNESS_CLAUDE=cxcl\n");

    expect(profileEnvSuffix("identity:client-x")).toBe("CLIENT_X");
    expect(profileScopedEnvName("client-x", "ROOTS")).toBe("SWARM_MCP_CLIENT_X_ROOTS");
    expect(
      launcherForIdentity("claude", "identity:client-x", {
        SWARM_MCP_PROFILE_DIR: profileDir,
      }),
    ).toBe("cxcl");
  });
});
