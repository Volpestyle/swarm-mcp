import { describe, expect, test } from "bun:test";
import * as prompts from "../src/prompts";

describe("prompts", () => {
  test("setup prompt includes the bootstrap flow", () => {
    const text = prompts.setup();

    expect(text).toContain("register");
    expect(text).toContain("bootstrap");
    expect(text).toContain("owner/planner");
    expect(text).toContain("fresh window");
  });

  test("protocol prompt includes lock and task guidance", () => {
    const text = prompts.protocol();

    expect(text).toContain("lock_file");
    expect(text).toContain("update_task");
    expect(text).toContain("review");
    expect(text).toContain("approval_required");
    expect(text).not.toContain("check_file");
  });

  test("docs snippets stay aligned with host-neutral usage", () => {
    expect(prompts.agents()).toContain("request_task");
    expect(prompts.agents()).toContain("broadcast");
    expect(prompts.agents()).toContain("team:frontend");
    expect(prompts.config()).toContain("[mcp_servers.swarm]");
    expect(prompts.config()).toContain('"type": "local"');
  });

  test("roleBootstrap returns role-specific guidance for known roles", () => {
    const planner = prompts.roleBootstrap("planner");
    expect(planner).toContain("planner");
    expect(planner).toContain("request_task");

    const implementer = prompts.roleBootstrap("implementer");
    expect(implementer).toContain("implementer");
    expect(implementer).toContain("lock_file");

    expect(prompts.roleBootstrap("reviewer")).toContain("reviewer");
    expect(prompts.roleBootstrap("researcher")).toContain("researcher");
  });

  test("roleBootstrap returns empty for missing or unknown roles", () => {
    expect(prompts.roleBootstrap(null)).toBe("");
    expect(prompts.roleBootstrap(undefined)).toBe("");
    expect(prompts.roleBootstrap("")).toBe("");
    expect(prompts.roleBootstrap("notarole")).toBe("");
  });
});
