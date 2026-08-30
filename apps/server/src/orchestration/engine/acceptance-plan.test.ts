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
  it("fills every uncovered deliverable criterion without inventing regression coverage", () => {
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
    expect(tests.some((test) => test.category === "regression")).toBe(false);
    expect(tests.flatMap((test) => test.criterionIds)).not.toContain("unknown");
  });

  it("removes orchestration-process assertions from the blocking product plan", () => {
    const processContract: ExecutionContract = {
      ...contract,
      criteria: [
        ...contract.criteria,
        { id: "verifier", kind: "functional", description: "The platform's built-in final verifier must verify the result", verification: "protected-test" },
        { id: "routing", kind: "functional", description: "Follow the worker-routing selection configured in the dashboard", verification: "visible-test" },
        { id: "runtime", kind: "runtime", description: "Required automated checks pass in the trusted verification environment", verification: "protected-test" },
      ],
    };
    const tests = comprehensiveAcceptanceTests([
      {
        id: "real-feature",
        title: "Feature behavior",
        criterionIds: ["functional"],
        category: "functional",
        scope: "protected",
        procedure: "Exercise the feature",
        expectedOutcome: "Feature works",
      },
      {
        id: "self-verification",
        title: "Platform built-in verifier passes all checks",
        criterionIds: ["verifier", "runtime"],
        category: "runtime",
        scope: "protected",
        procedure: "Ask the platform verifier whether it passed",
        expectedOutcome: "The platform built-in verifier passes",
      },
      {
        id: "routing-setting",
        title: "Follow worker-routing selection configured in the dashboard",
        criterionIds: ["routing"],
        category: "scope",
        scope: "global",
        procedure: "Inspect dashboard routing metadata",
        expectedOutcome: "Routing selection was followed",
      },
      {
        id: "unanchored-regression",
        title: "Existing regression suite remains healthy",
        criterionIds: [],
        category: "regression",
        scope: "global",
        procedure: "Run a suite if one exists",
        expectedOutcome: "A nonexistent suite passes",
      },
    ], processContract);

    expect(tests.map((test) => test.id)).toContain("real-feature");
    expect(tests.map((test) => test.id)).not.toContain("self-verification");
    expect(tests.map((test) => test.id)).not.toContain("routing-setting");
    expect(tests.map((test) => test.id)).not.toContain("unanchored-regression");
    expect(tests.flatMap((test) => test.criterionIds)).not.toEqual(
      expect.arrayContaining(["verifier", "routing", "runtime"]),
    );
  });
});
