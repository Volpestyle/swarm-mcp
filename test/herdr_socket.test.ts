import { describe, expect, test } from "bun:test";
import { delimiter, resolve } from "node:path";
import {
  identityFromEnv,
  personalControlRoot,
  preferredPersonalHerdrSocketPath,
  preferredWorkHerdrSocketPath,
  resolvedHerdrSocketPath,
} from "../src/herdr_socket";

describe("herdr socket path defaults", () => {
  test("uses an explicit HERDR_SOCKET_PATH unchanged", () => {
    expect(
      resolvedHerdrSocketPath({
        AGENT_IDENTITY: "work",
        HERDR_SOCKET_PATH: "/custom/herdr.sock",
      }),
    ).toBe("/custom/herdr.sock");
  });

  test("defaults personal identities to the host personal herdr session socket", () => {
    const env = {
      AGENT_IDENTITY: "personal",
      HERMES_HOST_HOME: "/Users/james.volpe",
      HOME: "/sandbox/home",
    };

    expect(identityFromEnv(env)).toBe("personal");
    expect(personalControlRoot(env)).toBe(resolve("/Users/james.volpe/volpestyle"));
    expect(preferredPersonalHerdrSocketPath(env)).toBe(
      resolve("/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock"),
    );
    expect(resolvedHerdrSocketPath(env)).toBe(
      resolve("/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock"),
    );
  });

  test("configured personal roots do not change the herdr control socket", () => {
    const env = {
      AGENT_IDENTITY: "identity:personal",
      HERMES_HOST_HOME: "/Users/james.volpe",
      SWARM_MCP_PERSONAL_ROOTS: ["/tmp/personal-root", "/tmp/other-root"].join(delimiter),
    };

    expect(resolvedHerdrSocketPath(env)).toBe(
      resolve("/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock"),
    );
  });

  test("defaults work identities to a separate host-visible socket", () => {
    const env = {
      AGENT_IDENTITY: "work",
      HERMES_HOST_HOME: "/Users/james.volpe",
      HOME: "/sandbox/home",
    };

    expect(preferredWorkHerdrSocketPath(env)).toBe(
      resolve("/Users/james.volpe/.config/herdr/sessions/work/herdr.sock"),
    );
    expect(resolvedHerdrSocketPath(env)).toBe(
      resolve("/Users/james.volpe/.config/herdr/sessions/work/herdr.sock"),
    );
  });
});
