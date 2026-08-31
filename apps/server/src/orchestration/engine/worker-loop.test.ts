import { describe, expect, it } from "vitest";
import {
  compactChangedPathSummary,
  isResumableWorkerTransportFailure,
  isWorkerExecutionBudgetBoundary,
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
    expect(isResumableWorkerTransportFailure("stream disconnected before completion"))
      .toBe(true);
    expect(isResumableWorkerTransportFailure("Per-execution input-token limit exceeded"))
      .toBe(false);
  });
});
