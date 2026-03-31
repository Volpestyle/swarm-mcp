import { describe, expect, test } from "bun:test";
import * as prompts from "../src/prompts";

describe("prompts", () => {
  test("setup prompt includes the bootstrap flow", () => {
    const text = prompts.setup();

    expect(text).toContain("register");
    expect(text).toContain("poll_messages");
    expect(text).toContain("list_tasks");
  });

  test("protocol prompt includes lock and task guidance", () => {
    const text = prompts.protocol();

    expect(text).toContain("check_file");
    expect(text).toContain("lock_file");
    expect(text).toContain("update_task");
  });

  test("docs snippets stay aligned with host-neutral usage", () => {
    expect(prompts.agents()).toContain("request_task");
    expect(prompts.agents()).toContain("broadcast");
    expect(prompts.config()).toContain("[mcp_servers.swarm]");
    expect(prompts.config()).toContain('"type": "local"');
  });
});
