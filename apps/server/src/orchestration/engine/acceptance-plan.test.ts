import { describe, expect, it } from "vitest";
import type { ExecutionContract } from "../contracts.js";
import { comprehensiveAcceptanceTests } from "./acceptance-plan.js";

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orchestration-1",
  version: 1,
  intent: {
    id: "intent-1",
    orchestrationId: "orchestration-1",
    revision: 1,
    goal: "Build a safe feature",
    requirements: ["Feature works"],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    materialQuestions: [],
    manualExpectations: ["Visual polish"],
    createdAt: "now",
  },
  criteria: [
    { id: "functional", kind: "functional", description: "Feature works", verification: "protected-test" },
    { id: "scope", kind: "scope", description: "No unrelated files change", verification: "static-check" },
    { id: "visual", kind: "manual", description: "Visual polish is acceptable", verification: "manual" },
  ],
  confirmedBy: "user",
  confirmedAt: "now",
  supersedesContractId: null,
};

describe("planner acceptance plan", () => {
  it("fills every uncovered criterion and always includes regression coverage", () => {
    const tests = comprehensiveAcceptanceTests([
      {
        id: "feature",
        title: "Feature behavior",
        criterionIds: ["functional", "unknown"],
        category: "functional",
        scope: "protected",
        procedure: "Exercise the feature",
        expectedOutcome: "Feature works",
      },
    ], contract);

    expect(new Set(tests.flatMap((test) => test.criterionIds))).toEqual(
      new Set(["functional", "scope", "visual"]),
    );
    expect(tests.find((test) => test.criterionIds.includes("visual"))?.scope).toBe("manual");
    expect(tests.some((test) => test.category === "regression")).toBe(true);
    expect(tests.flatMap((test) => test.criterionIds)).not.toContain("unknown");
  });
});
