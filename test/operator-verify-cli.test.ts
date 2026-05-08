import { describe, expect, test } from "bun:test";
import {
  buildOperatorProofSteps,
  parseOperatorVerifyCliArgs,
} from "../src/operatorVerifyCli";
import { assertOperatorProofClassified } from "../apps/swarm-ui/src/lib/operatorWorkflowProof";

describe("operator verify cli", () => {
  test("parses ui operator-verify intent", () => {
    expect(parseOperatorVerifyCliArgs([
      "swarm-mcp",
      "ui",
      "operator-verify",
      "--out",
      "output/operator-verification/latest",
    ])).toEqual({
      group: "ui",
      command: "operator-verify",
      out: "output/operator-verification/latest",
    });
  });

  test("builds a fully classified operator proof pack", () => {
    const steps = buildOperatorProofSteps({
      outDir: "/tmp/operator-verification",
      launchedAgent: {
        launchId: "launch-1",
        instanceId: null,
        ptyId: null,
        projectId: "project-1",
        scope: "/tmp/project",
        status: "not-attempted",
        visibleInCanvas: false,
        visibleInAnalyze: false,
        visibleInResumeCenter: false,
        cleanupActionVisible: false,
      },
      areaReport: {
        modeTargeted: true,
        nextReflected: true,
        confirmPersisted: true,
        persistedCaptureCount: 1,
        screenshotsDiffer: {
          targetVsNext: true,
          nextVsConfirm: true,
        },
      },
    });

    expect(steps.map((step) => step.id)).toEqual([
      "home-version-visible",
      "project-opened",
      "asset-primary-click-reflected",
      "report-mode-targeted",
      "report-next-reflected",
      "report-confirm-persisted",
      "agent-launch-visible",
      "agent-tracked-or-failed-visibly",
    ]);
    expect(steps.every((step) => step.status === "passed" || step.status === "manual-needed")).toBe(true);
    expect(() => assertOperatorProofClassified(steps)).not.toThrow();
  });

  test("fails report proof steps when screenshots do not change", () => {
    const steps = buildOperatorProofSteps({
      outDir: "/tmp/operator-verification",
      launchedAgent: {
        launchId: "launch-1",
        instanceId: null,
        ptyId: null,
        projectId: "project-1",
        scope: "/tmp/project",
        status: "not-attempted",
        visibleInCanvas: false,
        visibleInAnalyze: false,
        visibleInResumeCenter: false,
        cleanupActionVisible: false,
      },
      areaReport: {
        modeTargeted: true,
        nextReflected: true,
        confirmPersisted: true,
        persistedCaptureCount: 1,
        screenshotsDiffer: {
          targetVsNext: false,
          nextVsConfirm: false,
        },
      },
    });

    expect(steps.find((step) => step.id === "report-next-reflected")?.status).toBe("failed");
    expect(steps.find((step) => step.id === "report-confirm-persisted")?.status).toBe("failed");
    expect(() => assertOperatorProofClassified(steps)).toThrow("operator workflow proof missing required steps");
  });
});
