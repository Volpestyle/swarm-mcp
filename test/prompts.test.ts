import { describe, expect, test } from "bun:test";
import * as prompts from "../src/prompts";

describe("prompts", () => {
  test("setup prompt covers register + bootstrap and points to the skill", () => {
    const text = prompts.setup();

    expect(text).toContain("register");
    expect(text).toContain("bootstrap");
    expect(text).toContain("swarm-mcp");
    expect(text).toContain("skill");
  });

  test("protocol prompt is the inline doctrine fallback for plugin-less runtimes", () => {
    const text = prompts.protocol();

    expect(text).toContain("lock_file");
    expect(text).toContain("update_task");
    expect(text).toContain("review");
    expect(text).toContain("approval_required");
    expect(text).toContain("wait_for_activity");
    expect(text).toContain("swarm-mcp");
    expect(text).toContain("skill");
    expect(text).not.toContain("check_file");
  });

  test("roleBootstrap returns role-specific guidance with skill reference", () => {
    const planner = prompts.roleBootstrap("planner");
    expect(planner).toContain("planner");
    expect(planner).toContain("request_task");
    expect(planner).toContain("references/planner.md");

    const implementer = prompts.roleBootstrap("implementer");
    expect(implementer).toContain("implementer");
    expect(implementer).toContain("lock_file");
    expect(implementer).toContain("references/implementer.md");

    const reviewer = prompts.roleBootstrap("reviewer");
    expect(reviewer).toContain("reviewer");
    expect(reviewer).toContain("references/reviewer.md");

    const researcher = prompts.roleBootstrap("researcher");
    expect(researcher).toContain("researcher");
    expect(researcher).toContain("references/researcher.md");
  });

  test("roleBootstrap returns empty for missing or unknown roles", () => {
    expect(prompts.roleBootstrap(null)).toBe("");
    expect(prompts.roleBootstrap(undefined)).toBe("");
    expect(prompts.roleBootstrap("")).toBe("");
    expect(prompts.roleBootstrap("notarole")).toBe("");
  });
});
