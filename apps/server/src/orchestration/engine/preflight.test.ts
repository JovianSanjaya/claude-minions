import { describe, expect, it } from "vitest";
import type { ExecutionContract, OrchestrationTask } from "../contracts.js";
import {
  preflightReportSchema,
  reviewPreflight,
  summarizePreflight,
  type PreflightReport,
  type PreflightReviewInput,
} from "./preflight.js";

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orc-1",
  version: 1,
  intent: {
    id: "draft-1",
    orchestrationId: "orc-1",
    revision: 1,
    goal: "Add password reset",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    materialQuestions: [],
    manualExpectations: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  criteria: [],
  confirmedBy: "user",
  confirmedAt: "2026-01-01T00:00:00.000Z",
  supersedesContractId: null,
};

const task: OrchestrationTask = {
  id: "task-api",
  orchestrationId: "orc-1",
  title: "API",
  objective: "Implement the reset endpoint",
  status: "preflight",
  dependsOn: [],
  allowedPaths: ["src/api/**"],
  acceptanceCriterionIds: ["FR-1"],
  requiredArtifactIds: ["reset-token-contract"],
  observedArtifactVersions: {},
  applicationMapVersion: 1,
  attemptCount: 0,
};

const report = (overrides: Partial<PreflightReport> = {}): PreflightReport => ({
  understanding: "I will add a POST /reset endpoint that validates the reset token.",
  filesToChange: ["src/api/reset.ts"],
  artifactsToConsume: ["reset-token-contract"],
  artifactsToPublish: [],
  approach: "Validate the token, then call the persistence layer.",
  missingContext: [],
  plannedChecks: ["visible-tests"],
  ...overrides,
});

const review = (overrides: Partial<PreflightReviewInput> = {}) =>
  reviewPreflight({
    report: report(),
    task,
    contract,
    knownArtifacts: ["reset-token-contract"],
    priorExpansions: 0,
    maxExpansions: 2,
    allowedCheckIds: ["visible-tests"],
    ...overrides,
  });

describe("preflight schema", () => {
  it("parses a typed report and defaults optional arrays", () => {
    const parsed = preflightReportSchema.parse({
      understanding: "I understand the subtask well enough to plan it.",
      filesToChange: ["src/api/reset.ts"],
      approach: "Do the work",
    });
    expect(parsed.missingContext).toEqual([]);
    expect(parsed.plannedChecks).toEqual([]);
  });

  it("rejects an unbounded file list", () => {
    const result = preflightReportSchema.safeParse({
      understanding: "ok understanding of this subtask",
      filesToChange: Array.from({ length: 80 }, (_, index) => "f" + index + ".ts"),
      approach: "Do the work",
    });
    expect(result.success).toBe(false);
  });
});

describe("planner review of a preflight", () => {
  it("approves a plan inside scope", () => {
    expect(review()).toMatchObject({ decision: "approved" });
  });

  it("rejects a plan that would edit outside the allowed paths", () => {
    const decision = review({
      report: report({ filesToChange: ["src/api/reset.ts", "src/persistence/schema.ts"] }),
    });
    expect(decision).toMatchObject({ decision: "rejected" });
    expect(decision.reason).toContain("outside the task scope");
  });

  it("rejects a plan that depends on an unpublished artifact", () => {
    const decision = review({ knownArtifacts: [] });
    expect(decision).toMatchObject({ decision: "rejected" });
    expect(decision.reason).toContain("not been published");
  });

  it("rejects planned checks outside the trusted check set", () => {
    const decision = review({
      report: report({ plannedChecks: ["rm -rf /"] }),
    });
    expect(decision).toMatchObject({ decision: "rejected" });
    expect(decision.reason).toContain("trusted check set");
  });

  it("rejects a plan that changes nothing", () => {
    const decision = review({ report: report({ filesToChange: [] }) });
    expect(decision).toMatchObject({ decision: "rejected" });
  });

  it("rejects a plan that shows no understanding", () => {
    const decision = review({ report: report({ understanding: "ok" }) });
    expect(decision).toMatchObject({ decision: "rejected" });
  });

  it("grants a bounded number of narrow expansions", () => {
    const decision = review({
      report: report({
        missingContext: [
          { path: "src/persistence/schema.ts", reason: "I must honour the token shape" },
          { path: "src/web/form.ts", reason: "I must match the form field names" },
          { path: "src/other.ts", reason: "curiosity" },
        ],
      }),
      priorExpansions: 1,
      maxExpansions: 2,
    });
    expect(decision.decision).toBe("expand");
    if (decision.decision === "expand") {
      expect(decision.requests).toHaveLength(1);
    }
  });

  it("rejects an expansion request once the budget is exhausted", () => {
    const decision = review({
      report: report({
        missingContext: [{ path: "src/other.ts", reason: "one more file please" }],
      }),
      priorExpansions: 2,
      maxExpansions: 2,
    });
    expect(decision).toMatchObject({ decision: "rejected" });
    expect(decision.reason).toContain("expansion budget");
  });

  it("summarizes a plan compactly without the full approach text", () => {
    const summary = summarizePreflight(
      report({ approach: "z".repeat(4_000), artifactsToPublish: ["reset-token-contract"] }),
    );
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary).toContain("publishes: reset-token-contract");
    expect(summary).not.toContain("zzzz");
  });
});
