import { describe, expect, test } from "bun:test";
import {
  buildChromeLaunchArgs,
  normalizeCdpEndpoint,
  sanitizeArtifactName,
} from "../src/browser";

describe("browser bridge helpers", () => {
  test("normalizes CDP endpoints from ports and URLs", () => {
    expect(normalizeCdpEndpoint(9333)).toEqual({
      host: "127.0.0.1",
      port: 9333,
      baseUrl: "http://127.0.0.1:9333",
    });

    expect(normalizeCdpEndpoint("http://localhost:9444/json/version")).toEqual({
      host: "localhost",
      port: 9444,
      baseUrl: "http://localhost:9444",
    });

    expect(normalizeCdpEndpoint("localhost:9555")).toEqual({
      host: "localhost",
      port: 9555,
      baseUrl: "http://localhost:9555",
    });
  });

  test("builds isolated managed Chrome launch arguments", () => {
    const args = buildChromeLaunchArgs({
      port: 9555,
      profileDir: "/tmp/swarm-browser-profile",
      url: "https://example.com",
      headless: true,
    });

    expect(args).toContain("--remote-debugging-port=9555");
    expect(args).toContain("--user-data-dir=/tmp/swarm-browser-profile");
    expect(args).toContain("--remote-allow-origins=*");
    expect(args).toContain("--headless=new");
    expect(args.at(-1)).toBe("https://example.com");
  });

  test("sanitizes artifact names for screenshot paths", () => {
    expect(sanitizeArtifactName("Example / Search: Agent Context?")).toBe(
      "example-search-agent-context",
    );
    expect(sanitizeArtifactName("   ")).toBe("browser-context");
  });
});
