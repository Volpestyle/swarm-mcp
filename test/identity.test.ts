import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SWARM_DB_PATH = join(
  mkdtempSync(join(tmpdir(), "swarm-mcp-identity-")),
  "swarm.db",
);

const identity = await import("../src/identity");

describe("identityToken", () => {
  test("extracts identity:<name> token from label", () => {
    expect(
      identity.identityToken({ label: "identity:work role:planner session:abc" }),
    ).toBe("identity:work");
    expect(
      identity.identityToken({ label: "role:reviewer identity:personal claude-code" }),
    ).toBe("identity:personal");
  });

  test("returns empty string when no identity token present", () => {
    expect(identity.identityToken({ label: "role:planner platform:cli" })).toBe("");
    expect(identity.identityToken({ label: "" })).toBe("");
    expect(identity.identityToken({ label: null })).toBe("");
    expect(identity.identityToken(null)).toBe("");
    expect(identity.identityToken(undefined)).toBe("");
  });
});

describe("identityName", () => {
  test("returns just the identity name without prefix", () => {
    expect(
      identity.identityName({ label: "identity:work role:planner" }),
    ).toBe("work");
    expect(
      identity.identityName({ label: "identity:personal role:researcher" }),
    ).toBe("personal");
    expect(identity.identityName({ label: "role:planner" })).toBe("");
  });
});

describe("processIdentity", () => {
  const original = process.env.AGENT_IDENTITY;
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_IDENTITY;
    else process.env.AGENT_IDENTITY = original;
  });

  test("reads AGENT_IDENTITY env and returns identity:<name>", () => {
    process.env.AGENT_IDENTITY = "personal";
    expect(identity.processIdentity()).toBe("identity:personal");
    process.env.AGENT_IDENTITY = "work";
    expect(identity.processIdentity()).toBe("identity:work");
  });

  test("returns empty string when AGENT_IDENTITY unset or empty", () => {
    delete process.env.AGENT_IDENTITY;
    expect(identity.processIdentity()).toBe("");
    process.env.AGENT_IDENTITY = "";
    expect(identity.processIdentity()).toBe("");
    process.env.AGENT_IDENTITY = "   ";
    expect(identity.processIdentity()).toBe("");
  });
});

describe("crossIdentityReason", () => {
  const original = process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY;
  const originalUnlabeled = process.env.SWARM_MCP_ALLOW_UNLABELED;
  beforeEach(() => {
    delete process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY;
    delete process.env.SWARM_MCP_ALLOW_UNLABELED;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY;
    else process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY = original;
    if (originalUnlabeled === undefined) delete process.env.SWARM_MCP_ALLOW_UNLABELED;
    else process.env.SWARM_MCP_ALLOW_UNLABELED = originalUnlabeled;
  });

  test("blocks when both sides have different identity tokens", () => {
    const reason = identity.crossIdentityReason(
      { label: "identity:personal role:planner" },
      { label: "identity:work role:implementer" },
    );
    expect(reason).toMatch(/Cross-identity coordination blocked/);
    expect(reason).toMatch(/identity:personal/);
    expect(reason).toMatch(/identity:work/);
  });

  test("allows when both sides share the same identity", () => {
    expect(
      identity.crossIdentityReason(
        { label: "identity:personal role:planner" },
        { label: "identity:personal role:implementer" },
      ),
    ).toBeNull();
  });

  test("blocks when either side is missing an identity token", () => {
    expect(
      identity.crossIdentityReason(
        { label: "identity:personal role:planner" },
        { label: "role:implementer" },
      ),
    ).toMatch(/target has no identity token/);
    expect(
      identity.crossIdentityReason(
        { label: "role:planner" },
        { label: "identity:work role:implementer" },
      ),
    ).toMatch(/sender has no identity token/);
    expect(
      identity.crossIdentityReason({ label: null }, { label: null }),
    ).toMatch(/sender has no identity token/);
  });

  test("honors SWARM_MCP_ALLOW_UNLABELED escape hatch", () => {
    process.env.SWARM_MCP_ALLOW_UNLABELED = "1";
    expect(
      identity.crossIdentityReason(
        { label: "identity:personal role:planner" },
        { label: "role:implementer" },
      ),
    ).toBeNull();
    expect(
      identity.crossIdentityReason(
        { label: "role:planner" },
        { label: "identity:work role:implementer" },
      ),
    ).toBeNull();
    expect(
      identity.crossIdentityReason({ label: null }, { label: null }),
    ).toBeNull();
  });

  test("honors SWARM_MCP_ALLOW_CROSS_IDENTITY escape hatch", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
      process.env.SWARM_MCP_ALLOW_CROSS_IDENTITY = value;
      expect(
        identity.crossIdentityReason(
          { label: "identity:personal" },
          { label: "identity:work" },
        ),
      ).toBeNull();
    }
  });
});
