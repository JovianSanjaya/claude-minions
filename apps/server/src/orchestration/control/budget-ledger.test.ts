import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_POLICY,
  budgetPolicySchema,
  commitModelUsage,
  createEmptyUsageLedger,
  estimateExceedsBudget,
  reserveModelCall,
  type PricingTable,
} from "./budget-ledger.js";

const reservation = (overrides: Partial<Parameters<typeof reserveModelCall>[2]> = {}) => ({
  role: "worker" as const,
  modelId: "ep-cheap",
  estimatedInputTokens: 100,
  estimatedOutputTokens: 50,
  ...overrides,
});

describe("budgetPolicySchema", () => {
  it("fills in sane defaults for an empty override", () => {
    const policy = budgetPolicySchema.parse({});
    expect(policy).toEqual(DEFAULT_BUDGET_POLICY);
    expect(policy.maxInputTokens).toBeNull();
    expect(policy.maxModelCalls).toBeGreaterThan(0);
  });

  it("rejects negative, NaN, or absurdly large limits", () => {
    expect(() => budgetPolicySchema.parse({ maxModelCalls: -1 })).toThrow();
    expect(() => budgetPolicySchema.parse({ maxModelCalls: Number.NaN })).toThrow();
    expect(() => budgetPolicySchema.parse({ maxWallClockMs: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => budgetPolicySchema.parse({ maxModelCalls: 10_000 })).toThrow();
  });
});

describe("reserveModelCall", () => {
  it("allows a call within all limits", () => {
    const ledger = createEmptyUsageLedger();
    const budget = budgetPolicySchema.parse({ maxInputTokens: 1000, maxOutputTokens: 1000 });
    const decision = reserveModelCall(ledger, budget, reservation());
    expect(decision.allowed).toBe(true);
  });

  it("denies once the model-call count would be exceeded", () => {
    const ledger = createEmptyUsageLedger();
    const budget = budgetPolicySchema.parse({ maxModelCalls: 1 });
    let usage = ledger;
    usage = commitModelUsage(usage, "worker", "ep-cheap", {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
    });
    const decision = reserveModelCall(usage, budget, reservation());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/model call/i);
    }
  });

  it("denies once projected input tokens would exceed the hard budget", () => {
    const ledger = createEmptyUsageLedger();
    const budget = budgetPolicySchema.parse({ maxInputTokens: 50 });
    const decision = reserveModelCall(ledger, budget, reservation({ estimatedInputTokens: 51 }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/input token/i);
    }
  });

  it("denies once projected estimated dollar cost would exceed the hard budget", () => {
    const ledger = createEmptyUsageLedger();
    const budget = budgetPolicySchema.parse({ maxEstimatedUsd: 0.001 });
    const pricing: PricingTable = {
      worker: { inputPerToken: 0.0001, cachedInputPerToken: 0, outputPerToken: 0.0002 },
    };
    const decision = reserveModelCall(ledger, budget, reservation(), pricing);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/dollar/i);
    }
  });

  it("does not enforce a dollar cap when pricing is unknown for the role", () => {
    const ledger = createEmptyUsageLedger();
    const budget = budgetPolicySchema.parse({ maxEstimatedUsd: 0.0000001 });
    const decision = reserveModelCall(ledger, budget, reservation());
    expect(decision.allowed).toBe(true);
  });

  it("returns a unique reservation id on each allow", () => {
    const ledger = createEmptyUsageLedger();
    const first = reserveModelCall(ledger, DEFAULT_BUDGET_POLICY, reservation());
    const second = reserveModelCall(ledger, DEFAULT_BUDGET_POLICY, reservation());
    expect(first.allowed && second.allowed).toBe(true);
    if (first.allowed && second.allowed) {
      expect(first.reservationId).not.toBe(second.reservationId);
    }
  });
});

describe("commitModelUsage", () => {
  it("aggregates tokens and call count per role without mutating the input ledger", () => {
    const ledger = createEmptyUsageLedger();
    const updated = commitModelUsage(ledger, "planner", "ep-strong", {
      inputTokens: 200,
      cachedInputTokens: 20,
      outputTokens: 80,
    });
    expect(ledger.totalInputTokens).toBe(0);
    expect(updated.totalInputTokens).toBe(200);
    expect(updated.totalCachedInputTokens).toBe(20);
    expect(updated.totalOutputTokens).toBe(80);
    expect(updated.byRole.planner?.modelCalls).toBe(1);

    const updatedAgain = commitModelUsage(updated, "planner", "ep-strong", {
      inputTokens: 50,
      cachedInputTokens: 0,
      outputTokens: 10,
    });
    expect(updatedAgain.totalInputTokens).toBe(250);
    expect(updatedAgain.byRole.planner?.modelCalls).toBe(2);
  });

  it("keeps pricingStatus unknown and totalEstimatedUsd null with no pricing table", () => {
    const updated = commitModelUsage(createEmptyUsageLedger(), "worker", "ep-cheap", {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
    });
    expect(updated.pricingStatus).toBe("unknown");
    expect(updated.totalEstimatedUsd).toBeNull();
    expect(updated.byRole.worker?.estimatedUsd).toBeNull();
  });

  it("computes an estimated dollar total once every used role is priced", () => {
    const pricing: PricingTable = {
      worker: { inputPerToken: 0.001, cachedInputPerToken: 0, outputPerToken: 0.002 },
    };
    const updated = commitModelUsage(
      createEmptyUsageLedger(),
      "worker",
      "ep-cheap",
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 100 },
      pricing,
    );
    expect(updated.pricingStatus).toBe("configured");
    expect(updated.totalEstimatedUsd).toBeCloseTo(0.1 + 0.2);
  });

  it("falls back to unknown pricing overall when only some used roles are priced", () => {
    const pricing: PricingTable = {
      worker: { inputPerToken: 0.001, cachedInputPerToken: 0, outputPerToken: 0.002 },
    };
    let ledger = commitModelUsage(
      createEmptyUsageLedger(),
      "worker",
      "ep-cheap",
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 100 },
      pricing,
    );
    ledger = commitModelUsage(
      ledger,
      "planner",
      "ep-strong",
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 100 },
      pricing,
    );
    expect(ledger.pricingStatus).toBe("unknown");
    expect(ledger.totalEstimatedUsd).toBeNull();
  });
});

describe("estimateExceedsBudget", () => {
  it("returns null when the estimate fits within the hard budget", () => {
    const budget = budgetPolicySchema.parse({ maxInputTokens: 1000, maxOutputTokens: 1000 });
    const result = estimateExceedsBudget(
      { inputTokenLow: 100, outputTokenLow: 100, estimatedUsdLow: null },
      budget,
    );
    expect(result).toBeNull();
  });

  it("flags an estimate whose low-end token usage already exceeds the hard budget", () => {
    const budget = budgetPolicySchema.parse({ maxInputTokens: 50 });
    const result = estimateExceedsBudget(
      { inputTokenLow: 100, outputTokenLow: 10, estimatedUsdLow: null },
      budget,
    );
    expect(result).toMatch(/input tokens/i);
  });

  it("flags an estimate whose low-end dollar cost already exceeds the hard budget", () => {
    const budget = budgetPolicySchema.parse({ maxEstimatedUsd: 1 });
    const result = estimateExceedsBudget(
      { inputTokenLow: 1, outputTokenLow: 1, estimatedUsdLow: 5 },
      budget,
    );
    expect(result).toMatch(/dollar cost/i);
  });

  it("does not flag on dollar cost when pricing is unknown", () => {
    const budget = budgetPolicySchema.parse({ maxEstimatedUsd: 1 });
    const result = estimateExceedsBudget(
      { inputTokenLow: 1, outputTokenLow: 1, estimatedUsdLow: null },
      budget,
    );
    expect(result).toBeNull();
  });
});
