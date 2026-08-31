import { describe, expect, it } from "vitest";
import {
  compactChangedPathSummary,
  isResumableWorkerTransportFailure,
  isWorkerExecutionBudgetBoundary,
  selectAdaptiveWorkerProfile,
} from "./worker-loop.js";

describe("worker retry context", () => {
  it("summarizes large changed-file sets instead of serializing every path", () => {
    const changedFiles = Array.from(
      { length: 2_346 },
      (_, index) => `.npm-cache/_cacache/content-v2/sha512/${index}`,
    );
    const summary = compactChangedPathSummary({
      changedFiles,
      deletedFiles: ["old-file.ts"],
      hashes: {},
    }, 10);
    const parsed = JSON.parse(summary) as {
      totalChanged: number;
      totalDeleted: number;
      samplePaths: string[];
      omittedPaths: number;
    };

    expect(parsed).toEqual(expect.objectContaining({
      totalChanged: 2_346,
      totalDeleted: 1,
      omittedPaths: 2_337,
    }));
    expect(parsed.samplePaths).toHaveLength(10);
    expect(summary.length).toBeLessThan(1_000);
    expect(summary).not.toContain("/2345");
  });

  it("starts a fresh compact session at execution-budget boundaries but resumes transport failures", () => {
    expect(isWorkerExecutionBudgetBoundary("Per-execution input-token limit exceeded (250000/250000)"))
      .toBe(true);
    expect(isWorkerExecutionBudgetBoundary("Ark-turn limit exceeded (15/15)"))
      .toBe(true);
    expect(isWorkerExecutionBudgetBoundary("Per-execution tool-call limit exceeded (13/12)"))
      .toBe(true);
    expect(isResumableWorkerTransportFailure("stream disconnected before completion"))
      .toBe(true);
    expect(isResumableWorkerTransportFailure("Per-execution input-token limit exceeded"))
      .toBe(false);
  });

  it("selects bounded worker budgets from task and repository complexity", () => {
    expect(selectAdaptiveWorkerProfile({
      allowedPaths: ["index.html", "styles.css"],
      criterionCount: 3,
      repositoryFileCount: 20,
    })).toEqual({ name: "simple", maximumFailureAttempts: 2, timeoutMs: 180_000 });
    expect(selectAdaptiveWorkerProfile({
      allowedPaths: ["apps/web", "apps/server", "packages/shared"],
      criterionCount: 8,
      repositoryFileCount: 140,
    })).toEqual({ name: "standard", maximumFailureAttempts: 3, timeoutMs: 300_000 });
    expect(selectAdaptiveWorkerProfile({
      allowedPaths: ["."],
      criterionCount: 12,
      repositoryFileCount: 600,
    })).toEqual({ name: "complex", maximumFailureAttempts: 4, timeoutMs: 480_000 });
  });
});
