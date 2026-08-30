import { describe, expect, it } from "vitest";
import type { OrchestrationTask } from "../contracts.js";
import { reviewPreflight, runPreflight, type PreflightPlan } from "./preflight.js";
import { createFakeAgentRunner, createInMemorySink } from "./test-doubles.js";

const task: OrchestrationTask = {
  id: "task-1",
  orchestrationId: "orch-1",
  title: "Auth work",
  objective: "Add password reset",
  status: "preflight",
  dependsOn: [],
  allowedPaths: ["src/auth"],
  acceptanceCriterionIds: [],
  requiredArtifactIds: [],
  observedArtifactVersions: {},
  applicationMapVersion: 1,
  attemptCount: 0,
};

function plan(overrides: Partial<PreflightPlan> = {}): PreflightPlan {
  return {
    understanding: "Add a password reset endpoint",
    filesExpectedToChange: ["src/auth/reset.ts"],
    approach: "Add a new handler and token model",
    missingContextRequests: [],
    plannedChecks: ["unit tests"],
    ...overrides,
  };
}

describe("reviewPreflight", () => {
  it("approves a plan whose files stay within the task's allowed paths", () => {
    const review = reviewPreflight(plan(), task);
    expect(review.approved).toBe(true);
  });

  it("rejects a plan that touches files outside the allowed paths", () => {
    const review = reviewPreflight(plan({ filesExpectedToChange: ["src/billing/invoice.ts"] }), task);
    expect(review.approved).toBe(false);
    expect(review.reason).toMatch(/outside/i);
  });
});

describe("runPreflight", () => {
  it("calls the worker role in read-only mode and reviews the resulting plan", async () => {
    let sawSandboxMode: string | undefined;
    const runner = createFakeAgentRunner((request) => {
      sawSandboxMode = request.sandboxMode;
      return {
        output: JSON.stringify(plan()),
        threadId: null,
        usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 30 },
      };
    });
    const sink = createInMemorySink();
    const result = await runPreflight(
      { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
      {
        agentId: "agent-1",
        orchestrationId: "orch-1",
        task,
        contract: {
          id: "c1",
          orchestrationId: "orch-1",
          version: 1,
          intent: {
            id: "d1",
            orchestrationId: "orch-1",
            revision: 0,
            goal: "",
            requirements: [],
            assumptions: [],
            nonGoals: [],
            architectureDecisions: [],
            manualExpectations: [],
            openQuestions: [],
            createdAt: new Date().toISOString(),
          },
          criteria: [],
          confirmedBy: "user",
          confirmedAt: new Date().toISOString(),
          supersedesContractId: null,
        },
        contextSummary: "2 files",
        workspacePath: "/workspaces/task-1",
        signal: new AbortController().signal,
      },
    );
    expect(sawSandboxMode).toBe("read-only");
    expect(result.review.approved).toBe(true);
    expect(result.plan.approach).toContain("token model");
  });
});
