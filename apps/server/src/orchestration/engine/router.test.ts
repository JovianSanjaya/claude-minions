import { describe, expect, it } from "vitest";
import type { BudgetPolicy } from "../contracts.js";
import { RoutingError, selectExecutionRoute } from "./router.js";

const budget: BudgetPolicy = {
  maxInputTokens: 100_000,
  maxOutputTokens: 50_000,
  maxEstimatedUsd: null,
  maxModelCalls: 20,
  maxSteps: 30,
  maxWorkerAttempts: 2,
  maxContextExpansionsPerTask: 2,
  maxWallClockMs: 300_000,
};

describe("adaptive router", () => {
  it("chooses direct for tiny work and one worker for coupled work", () => {
    expect(
      selectExecutionRoute({
        requestedMode: "auto",
        tasks: [{ dependsOn: [], allowedPaths: ["src/a.ts"] }],
        criterionCount: 1,
        applicationFileCount: 10,
        budget,
      }).selectedMode,
    ).toBe("direct");
    expect(
      selectExecutionRoute({
        requestedMode: "auto",
        tasks: [
          { dependsOn: [], allowedPaths: ["src/a.ts"] },
          { dependsOn: ["a"], allowedPaths: ["src/b.ts"] },
        ],
        criterionCount: 5,
        applicationFileCount: 100,
        budget,
      }).selectedMode,
    ).toBe("one-worker");
  });

  it("chooses multiple workers for modular scopes and refuses impossible forced delegation", () => {
    expect(
      selectExecutionRoute({
        requestedMode: "orchestrated",
        tasks: [
          { dependsOn: [], allowedPaths: ["server/a.ts"] },
          { dependsOn: [], allowedPaths: ["web/b.ts"] },
        ],
        criterionCount: 4,
        applicationFileCount: 100,
        budget,
      }).selectedMode,
    ).toBe("multi-worker");
    expect(() =>
      selectExecutionRoute({
        requestedMode: "orchestrated",
        tasks: [{ dependsOn: [], allowedPaths: ["src/a.ts"] }],
        criterionCount: 1,
        applicationFileCount: 10,
        budget: { ...budget, maxModelCalls: 1 },
      }),
    ).toThrow(RoutingError);
  });
});
