import { describe, expect, it } from "vitest";
import { buildFailurePacket, classifyFailure } from "./failure-packet.js";
import type { ExecutionContract, OrchestrationTask, VerificationRecord } from "../contracts.js";

const task: OrchestrationTask = {
  id: "task-1",
  orchestrationId: "orch-1",
  title: "Auth work",
  objective: "x",
  status: "failed",
  dependsOn: [],
  allowedPaths: ["src/auth"],
  acceptanceCriterionIds: [],
  requiredArtifactIds: [],
  observedArtifactVersions: {},
  applicationMapVersion: 1,
  attemptCount: 1,
};

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orch-1",
  version: 1,
  intent: {
    id: "draft-1",
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
};

function check(status: VerificationRecord["status"], output: string): VerificationRecord {
  return {
    id: "v1",
    orchestrationId: "orch-1",
    taskId: "task-1",
    scope: "worker-visible",
    commandOrCheck: "test",
    status,
    outputSummary: output,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

describe("buildFailurePacket", () => {
  it("compresses evidence without including raw reasoning or unbounded output", () => {
    const packet = buildFailurePacket(
      task,
      contract,
      2,
      ["src/auth/reset.ts"],
      [check("failed", "x".repeat(10_000))],
      "y".repeat(10_000),
      { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    );
    expect(packet.lastError.length).toBeLessThanOrEqual(2000);
    expect(packet.failingChecks[0]?.length).toBeLessThan(400);
    expect(packet.changedFiles).toEqual(["src/auth/reset.ts"]);
  });
});

describe("classifyFailure", () => {
  it("classifies budget exhaustion first regardless of the error text", () => {
    const packet = buildFailurePacket(task, contract, 1, [], [], "some ordinary error", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(packet, true)).toBe("budget-exhaustion");
  });

  it("classifies a zero-attempt failure as an invalid plan", () => {
    const packet = buildFailurePacket(task, contract, 0, [], [], "preflight rejected", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(packet, false)).toBe("invalid-plan");
  });

  it("classifies stale-dependency, missing-context, ambiguous-contract, and suspected-bad-check by keyword", () => {
    const stale = buildFailurePacket(task, contract, 1, [], [], "the interface is stale and out of date", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(stale, false)).toBe("stale-dependency");

    const missing = buildFailurePacket(task, contract, 1, [], [], "missing context: no schema file was provided", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(missing, false)).toBe("missing-context");

    const ambiguous = buildFailurePacket(task, contract, 1, [], [], "this appears to be a contract conflict", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(ambiguous, false)).toBe("ambiguous-contract");

    const badCheck = buildFailurePacket(task, contract, 1, [], [], "the evaluator: bad check configuration", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(badCheck, false)).toBe("suspected-bad-check");
  });

  it("falls through to weak-model after repeated attempts, or implementation-bug otherwise", () => {
    const repeated = buildFailurePacket(task, contract, 3, [], [], "generic failure", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(repeated, false)).toBe("weak-model");

    const generic = buildFailurePacket(task, contract, 1, [], [], "generic failure", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(classifyFailure(generic, false)).toBe("implementation-bug");
  });
});
