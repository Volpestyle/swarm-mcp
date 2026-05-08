import { describe, expect, test } from "bun:test";
import {
  assertVisualAtlasCoverage,
  parseVisualAtlasCliArgs,
  visualAtlasCoverageReportForSurfaces,
} from "../src/visualAtlasCli";

describe("visual atlas cli", () => {
  test("parses ui visual-atlas intent", () => {
    expect(parseVisualAtlasCliArgs([
      "swarm-mcp",
      "ui",
      "visual-atlas",
      "--out",
      "output/visual-atlas/latest",
    ])).toEqual({
      group: "ui",
      command: "visual-atlas",
      out: "output/visual-atlas/latest",
    });
  });

  test("fails coverage reports with missing controls", () => {
    const report = visualAtlasCoverageReportForSurfaces([
      {
        id: "test-surface",
        label: "Test surface",
        route: "visual-atlas",
        expectedBehavior: "test behavior",
        proofLevel: "source-confirmed",
        controls: [
          {
            id: "test.missing-coverage",
            surfaceId: "test-surface",
            label: "Missing coverage",
            kind: "button",
            testId: "test-missing-coverage",
            reportTargetId: "test-missing-coverage",
            expectedBehavior: "should fail until covered",
            proofLevel: "missing-coverage",
            coverage: "missing-coverage",
            assetLike: false,
            clickability: "primary-clickable",
            reportability: "reportable",
            primaryAction: "click-test",
            reportAction: "capture-test",
          },
        ],
      },
    ]);

    expect(report.ok).toBe(false);
    expect(() => assertVisualAtlasCoverage(report)).toThrow("visual atlas failed: missing coverage");
  });
});
