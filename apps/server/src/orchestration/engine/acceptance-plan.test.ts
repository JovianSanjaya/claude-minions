import { describe, expect, it } from "vitest";
import type { ExecutionContract } from "../contracts.js";
import {
  comprehensiveAcceptanceTests,
  requiresPostReleaseVerification,
} from "./acceptance-plan.js";

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
    expect(tests.find((test) => test.category === "regression")?.expectedOutcome)
      .toContain("explicitly skipped as not applicable");
    expect(tests.flatMap((test) => test.criterionIds)).not.toContain("unknown");
  });

  it("forces checks of the eventual assistant reply out of the release gate", () => {
    const [test] = comprehensiveAcceptanceTests([
      {
        id: "reply",
        title: "User receives the location",
        criterionIds: ["functional"],
        category: "functional",
        scope: "global",
        verificationPhase: "release-gate",
        procedure: "Review the agent's final response to the user",
        expectedOutcome: "The final response mentions index.html",
      },
    ], contract);

    expect(test.verificationPhase).toBe("post-release");
    expect(requiresPostReleaseVerification(test)).toBe(true);
  });

  it("classifies uncovered user-communication criteria as post-release", () => {
    const responseContract: ExecutionContract = {
      ...contract,
      criteria: [
        {
          id: "reply",
          kind: "functional",
          description: "Tell the user how to open the game",
          verification: "visible-test",
        },
      ],
    };

    const tests = comprehensiveAcceptanceTests([], responseContract);
    const reply = tests.find((test) => test.criterionIds.includes("reply"));

    expect(reply).toMatchObject({ verificationPhase: "post-release" });
    expect(reply?.procedure).toContain("only after verified publication");
  });
});
