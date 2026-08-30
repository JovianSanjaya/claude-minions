import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../contracts.js";
import {
  buildFailurePacket,
  classifyFailure,
  renderFailurePacket,
  type DiagnosisContext,
} from "./failure-packet.js";

const usage: TokenUsage = { inputTokens: 100, cachedInputTokens: 10, outputTokens: 50 };

const context = (overrides: Partial<DiagnosisContext> = {}): DiagnosisContext => ({
  dependencyStale: false,
  deniedExpansions: 0,
  budgetDenied: false,
  scopeViolations: [],
  attemptsAllowed: 3,
  noChangesProduced: false,
  repeatedProtectedFailure: false,
  structuredOutputFailures: 0,
  ...overrides,
});

describe("failure packet compression", () => {
  it("bounds the error, checks, files and diagnosis", () => {
    const packet = buildFailurePacket({
      taskId: "task-api",
      contractVersion: 2,
      attemptCount: 3,
      lastError: "e".repeat(5_000),
      failingChecks: Array.from({ length: 20 }, (_, index) => "check-" + index),
      changedFiles: Array.from({ length: 40 }, (_, index) => "src/file-" + index + ".ts"),
      addedFiles: ["src/new.ts"],
      removedFiles: [],
      relevantInterfaces: ["reset-token-contract@v2"],
      workerDiagnosis: "d".repeat(5_000),
      usage,
    });

    expect(packet.lastError.length).toBeLessThanOrEqual(603);
    expect(packet.failingChecks).toHaveLength(8);
    expect(packet.changedFiles).toHaveLength(20);
    expect(packet.workerDiagnosis.length).toBeLessThanOrEqual(603);
    expect(packet.diffSummary).toContain("40 modified");
    expect(packet.diffSummary).toContain("1 added");
    expect(packet.usage).toEqual(usage);
  });

  it("renders a compact, safe escalation summary", () => {
    const packet = buildFailurePacket({
      taskId: "task-api",
      contractVersion: 1,
      attemptCount: 2,
      lastError: "expired token accepted",
      failingChecks: ["visible-tests"],
      changedFiles: ["src/api/reset.ts"],
      relevantInterfaces: ["reset-token-contract@v1"],
      workerDiagnosis: "expiry comparison uses the wrong clock",
      usage,
    });
    const rendered = renderFailurePacket(packet);
    expect(rendered).toContain("task=task-api");
    expect(rendered).toContain("failingChecks=visible-tests");
    expect(rendered).not.toContain("chain-of-thought");
  });
});

describe("failure classification", () => {
  const packet = buildFailurePacket({
    taskId: "task-api",
    contractVersion: 1,
    attemptCount: 3,
    lastError: "visible checks failed",
    failingChecks: ["visible-tests"],
    changedFiles: ["src/api/reset.ts"],
    relevantInterfaces: [],
    workerDiagnosis: "not sure",
    usage,
  });

  it("classifies a budget stop first", () => {
    expect(classifyFailure(packet, context({ budgetDenied: true }))).toMatchObject({
      classification: "budget-exhaustion",
      action: "stop",
    });
  });

  it("classifies a stale dependency", () => {
    expect(classifyFailure(packet, context({ dependencyStale: true }))).toMatchObject({
      classification: "stale-dependency",
      action: "dependency-refresh",
    });
  });

  it("classifies a scope violation as an invalid plan", () => {
    expect(
      classifyFailure(packet, context({ scopeViolations: ["src/other.ts"] })),
    ).toMatchObject({ classification: "invalid-plan", action: "focused-replan" });
  });

  it("classifies missing context when nothing changed or expansion was denied", () => {
    expect(classifyFailure(packet, context({ noChangesProduced: true }))).toMatchObject({
      classification: "missing-context",
      action: "narrow-expansion",
    });
    expect(classifyFailure(packet, context({ deniedExpansions: 1 }))).toMatchObject({
      classification: "missing-context",
    });
  });

  it("classifies repeated unusable output as a weak model", () => {
    expect(
      classifyFailure(packet, context({ structuredOutputFailures: 2 })),
    ).toMatchObject({ classification: "weak-model", action: "stronger-model" });
  });

  it("escalates a repeatedly failing protected check as a material amendment, never a silent weakening", () => {
    const diagnosis = classifyFailure(
      packet,
      context({ repeatedProtectedFailure: true }),
    );
    expect(diagnosis).toMatchObject({
      classification: "suspected-bad-check",
      action: "material-amendment",
    });
    expect(diagnosis.reason).toContain("rather than weakened");
  });

  it("falls back to an implementation bug with a focused replan", () => {
    expect(classifyFailure(packet, context())).toMatchObject({
      classification: "implementation-bug",
      action: "focused-replan",
    });
  });
});
