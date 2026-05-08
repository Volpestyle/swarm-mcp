import { describe, expect, test } from "bun:test";
import * as prompts from "../src/prompts";
import { STANDBY_REGISTER_PROMPT } from "../src/registerPrompts";

describe("prompts", () => {
  test("setup prompt includes the bootstrap flow", () => {
    const text = prompts.setup();

    expect(text).toContain("register");
    expect(text).toContain("poll_messages");
    expect(text).toContain("list_tasks");
    expect(text).toContain("owner/planner");
    expect(text).toContain("fresh window");
  });

  test("protocol prompt includes lock and task guidance", () => {
    const text = prompts.protocol();

    expect(text).toContain("check_file");
    expect(text).toContain("lock_file");
    expect(text).toContain("update_task");
    expect(text).toContain("review");
    expect(text).toContain("approval_required");
    expect(text).toContain("operator:<scope>");
    expect(text).toContain("shared Conversation panel");
    expect(text).toContain("work item, planning/design discussion, or conversation");
    expect(text).toContain("browser_updates");
  });

  test("browser prompt describes managed browser workflow", () => {
    const text = prompts.browser();

    expect(text).toContain("swarm://browser");
    expect(text).toContain("browser_open");
    expect(text).toContain("browser_ui_open");
    expect(text).toContain("browser_ui_import_active_tab");
    expect(text).toContain("browser_snapshot");
    expect(text).toContain("browser_updates");
    expect(text).toContain("normal Chrome tabs");
  });

  test("docs snippets stay aligned with host-neutral usage", () => {
    expect(prompts.agents()).toContain("request_task");
    expect(prompts.agents()).toContain("broadcast");
    expect(prompts.agents()).toContain("team:frontend");
    expect(prompts.agents()).toContain("browser_contexts");
    expect(prompts.agents()).toContain("browser_ui_capture_snapshot");
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

  test("standby register prompt allows operator broadcast chat without starting work", () => {
    expect(STANDBY_REGISTER_PROMPT).toContain("operator:");
    expect(STANDBY_REGISTER_PROMPT).toContain("shared operator broadcast does not authorize code/repo work");
    expect(STANDBY_REGISTER_PROMPT).toContain("checks whether you are alive");
    expect(STANDBY_REGISTER_PROMPT).toContain("reply with a short broadcast");
    expect(STANDBY_REGISTER_PROMPT).toContain("direct operator message names your instance id");
    expect(STANDBY_REGISTER_PROMPT).toContain("task is assigned to your exact instance id");
  });
});
