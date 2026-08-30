import { describe, expect, it } from "vitest";
import type { BudgetPolicy } from "../contracts.js";
import { decideRoute, type RouteSignals } from "./router.js";

const budget = (overrides: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  maxInputTokens: null,
  maxOutputTokens: null,
  maxEstimatedUsd: null,
  maxModelCalls: 40,
  maxSteps: 60,
  maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 2,
  maxWallClockMs: 900_000,
  ...overrides,
});

const signals = (overrides: Partial<RouteSignals> = {}): RouteSignals => ({
  requestedMode: "auto",
  proposedTaskCount: 3,
  distinctAreas: 3,
  overlappingPathCount: 0,
  totalPathCount: 3,
  contextFileCount: 12,
  mapFileCount: 60,
  decomposable: true,
  budget: budget(),
  ...overrides,
});

describe("adaptive routing", () => {
  it("routes tiny work directly", () => {
    const decision = decideRoute(
      signals({ proposedTaskCount: 1, totalPathCount: 1, contextFileCount: 1, distinctAreas: 1 }),
    );
    expect(decision).toMatchObject({ ok: true, mode: "direct" });
  });

  it("routes tightly coupled work to a single focused worker", () => {
    const decision = decideRoute(
      signals({ proposedTaskCount: 3, overlappingPathCount: 3, totalPathCount: 4 }),
    );
    expect(decision).toMatchObject({ ok: true, mode: "one-worker" });
    if (decision.ok) expect(decision.reason).toContain("coupling");
  });

  it("routes modular work to multiple workers", () => {
    const decision = decideRoute(signals());
    expect(decision).toMatchObject({ ok: true, mode: "multi-worker" });
    if (decision.ok) expect(decision.reason).toContain("modular");
  });

  it("degrades to a cheaper mode when the model-call budget is small", () => {
    const decision = decideRoute(signals({ budget: budget({ maxModelCalls: 9 }) }));
    expect(decision).toMatchObject({ ok: true, mode: "one-worker" });
  });

  it("falls back to direct when even one worker is unaffordable", () => {
    const decision = decideRoute(signals({ budget: budget({ maxModelCalls: 6 }) }));
    expect(decision).toMatchObject({ ok: true, mode: "direct" });
  });

  it("fails safely when no mode fits the hard budget", () => {
    const decision = decideRoute(signals({ budget: budget({ maxModelCalls: 2 }) }));
    expect(decision.ok).toBe(false);
  });

  it("honours an explicit direct request", () => {
    const decision = decideRoute(signals({ requestedMode: "direct" }));
    expect(decision).toMatchObject({ ok: true, mode: "direct" });
  });

  it("forces delegation when requested and feasible", () => {
    const decision = decideRoute(
      signals({ requestedMode: "orchestrated", proposedTaskCount: 2, distinctAreas: 2, totalPathCount: 2 }),
    );
    expect(decision).toMatchObject({ ok: true, mode: "multi-worker" });
  });

  it("refuses forced delegation when the contract is not decomposable", () => {
    const decision = decideRoute(
      signals({ requestedMode: "orchestrated", decomposable: false }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("not decomposable");
  });
});
