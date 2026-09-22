import { expect, test } from "bun:test";
import { build } from "esbuild";

test("domain core has no transitive MCP or host SDK runtime dependency", async () => {
  const result = await build({
    entryPoints: ["src/coordination/core.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
  });
  const imports = Object.values(result.metafile!.outputs).flatMap((output) =>
    output.imports.map((item) => item.path),
  );
  expect(
    imports.filter(
      (path) =>
        path.startsWith("@modelcontextprotocol/") ||
        path.startsWith("@opencode-ai/"),
    ),
  ).toEqual([]);
});

test("thin IPC clients do not eagerly load the MCP server SDK", async () => {
  const result = await build({
    entryPoints: ["src/coordination/ipc.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    metafile: true,
  });
  const imports = Object.values(result.metafile!.outputs).flatMap(
    (output) => output.imports,
  );
  expect(
    imports.filter(
      (item) =>
        item.path.startsWith("@modelcontextprotocol/") &&
        item.kind !== "dynamic-import",
    ),
  ).toEqual([]);
});
