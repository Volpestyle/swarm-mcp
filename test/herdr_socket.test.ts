import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { identityFromEnv, resolvedHerdrSocketPath } from "../src/herdr_socket";

let profileDir: string;

beforeAll(() => {
  profileDir = mkdtempSync(resolve(tmpdir(), "swarm-mcp-test-profiles-"));
  writeFileSync(
    resolve(profileDir, "personal.env"),
    [
      "AGENT_IDENTITY=personal",
      "HERDR_SOCKET_PATH=/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock",
    ].join("\n"),
  );
  writeFileSync(
    resolve(profileDir, "work.env"),
    [
      "AGENT_IDENTITY=work",
      "HERDR_SOCKET_PATH=/Users/james.volpe/.config/herdr/sessions/work/herdr.sock",
    ].join("\n"),
  );
  writeFileSync(
    resolve(profileDir, "expanded.env"),
    [
      "SOCKET_ROOT=${HERMES_HOST_HOME:-$HOME}/.config/herdr/sessions/expanded",
      "HERDR_SOCKET_PATH=$SOCKET_ROOT/herdr.sock",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

describe("herdr socket path resolution", () => {
  test("uses an explicit HERDR_SOCKET_PATH unchanged", () => {
    expect(
      resolvedHerdrSocketPath({
        AGENT_IDENTITY: "work",
        HERDR_SOCKET_PATH: "/custom/herdr.sock",
        SWARM_MCP_PROFILE_DIR: profileDir,
      }),
    ).toBe("/custom/herdr.sock");
  });

  test("loads socket path from the current identity's profile env file", () => {
    const env = {
      AGENT_IDENTITY: "personal",
      SWARM_MCP_PROFILE_DIR: profileDir,
    };

    expect(identityFromEnv(env)).toBe("personal");
    expect(resolvedHerdrSocketPath(env)).toBe(
      "/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock",
    );
  });

  test("expands simple shell-style env values from profile env files", () => {
    expect(
      resolvedHerdrSocketPath({
        AGENT_IDENTITY: "expanded",
        HOME: "/Users/fallback",
        HERMES_HOST_HOME: "/Users/host",
        SWARM_MCP_PROFILE_DIR: profileDir,
      }),
    ).toBe("/Users/host/.config/herdr/sessions/expanded/herdr.sock");
  });

  test("falls back to empty string when the profile env file is missing", () => {
    expect(
      resolvedHerdrSocketPath({
        AGENT_IDENTITY: "no-such-profile",
        SWARM_MCP_PROFILE_DIR: profileDir,
      }),
    ).toBe("");
  });

  test("accepts identity tokens with the identity: prefix", () => {
    expect(
      resolvedHerdrSocketPath({
        AGENT_IDENTITY: "identity:work",
        SWARM_MCP_PROFILE_DIR: profileDir,
      }),
    ).toBe("/Users/james.volpe/.config/herdr/sessions/work/herdr.sock");
  });

  test("returns empty when no identity is set", () => {
    expect(resolvedHerdrSocketPath({ SWARM_MCP_PROFILE_DIR: profileDir })).toBe("");
  });
});
