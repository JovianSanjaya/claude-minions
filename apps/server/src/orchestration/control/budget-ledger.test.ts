import { describe, expect, it } from "vitest";
import type { BudgetPolicy, ModelCallReservation } from "../contracts.js";
import {
  applyUsage,
  BUDGET_LIMITS,
  createBudgetState,
  DEFAULT_BUDGET_POLICY,
  emptyUsageLedger,
  evaluateContextExpansion,
  evaluateModelCall,
  evaluateWorkerAttempt,
  normalizeBudgetPolicy,
  normalizeTokenUsage,
  openReservationTotals,
  PricingBook,
  type BudgetContext,
} from "./budget-ledger.js";
import type { BudgetState } from "./store.js";

const PRICED = new PricingBook({
  "planner-model": {
    inputUsdPerMillionTokens: 10,
    cachedInputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 30,
  },
  "worker-model": {
    inputUsdPerMillionTokens: 1,
    cachedInputUsdPerMillionTokens: 0.1,
    outputUsdPerMillionTokens: 3,
  },
});
const UNPRICED = new PricingBook({});

function policy(overrides: Partial<BudgetPolicy> = {}): BudgetPolicy {
  return { ...DEFAULT_BUDGET_POLICY, ...overrides };
}

function context(
  overrides: {
    budget?: BudgetPolicy;
    state?: Partial<BudgetState>;
    usage?: BudgetContext["usage"];
    pricing?: PricingBook;
    nowMs?: number;
  } = {},
): BudgetContext {
  return {
    budget: overrides.budget ?? policy(),
    usage: overrides.usage ?? emptyUsageLedger(false),
    state: { ...createBudgetState("orchestration-1", null), ...overrides.state },
    pricing: overrides.pricing ?? UNPRICED,
    nowMs: overrides.nowMs ?? 1_000,
  };
}

function reservation(
  overrides: Partial<ModelCallReservation> = {},
): ModelCallReservation {
  return {
    orchestrationId: "orchestration-1",
    taskId: null,
    executionId: "execution-1",
    role: "planner",
    modelId: "planner-model",
    estimatedInputTokens: 1_000,
    estimatedOutputTokens: 500,
    ...overrides,
  };
}

describe("pricing", () => {
  it("returns null for an unconfigured model instead of guessing", () => {
    expect(
      UNPRICED.estimateUsd("planner-model", {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
      }),
    ).toBeNull();
    expect(UNPRICED.isConfigured).toBe(false);
    expect(PRICED.has("worker-model")).toBe(true);
    expect(PRICED.has("unknown-model")).toBe(false);
  });

  it("computes estimated dollars from configured per-million rates", () => {
    expect(
      PRICED.estimateUsd("planner-model", {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(41);
  });
});

describe("budget decisions", () => {
  it("allows a call inside every limit", () => {
    expect(evaluateModelCall(context(), reservation())).toEqual({ allowed: true });
  });

  it("denies once the model-call limit is reached", () => {
    const decision = evaluateModelCall(
      context({ budget: policy({ maxModelCalls: 2 }), state: { modelCalls: 2 } }),
      reservation(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/Model-call budget/);
  });

  it("denies once the step limit is reached", () => {
    const decision = evaluateModelCall(
      context({ budget: policy({ maxSteps: 3 }), state: { steps: 3 } }),
      reservation(),
    );
    expect(decision.allowed === false && decision.reason).toMatch(/Step budget/);
  });

  it("counts open reservations conservatively against the input-token limit", () => {
    const state: Partial<BudgetState> = {
      reservations: [
        {
          id: "reservation-1",
          orchestrationId: "orchestration-1",
          taskId: null,
          executionId: "execution-0",
          role: "planner",
          modelId: "planner-model",
          estimatedInputTokens: 900,
          estimatedOutputTokens: 100,
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          settledAt: null,
        },
      ],
    };
    const decision = evaluateModelCall(
      context({ budget: policy({ maxInputTokens: 1_500 }), state }),
      reservation({ estimatedInputTokens: 700 }),
    );
    expect(decision.allowed === false && decision.reason).toMatch(/Input-token budget/);

    const totals = openReservationTotals(
      { ...createBudgetState("orchestration-1", null), ...state },
      PRICED,
    );
    expect(totals.inputTokens).toBe(900);
  });

  it("denies on the output-token limit", () => {
    const decision = evaluateModelCall(
      context({ budget: policy({ maxOutputTokens: 100 }) }),
      reservation({ estimatedOutputTokens: 500 }),
    );
    expect(decision.allowed === false && decision.reason).toMatch(/Output-token budget/);
  });

  it("enforces the estimated-dollar limit only when pricing is configured", () => {
    const budget = policy({
      maxEstimatedUsd: 0.000001,
      maxInputTokens: null,
      maxOutputTokens: null,
    });
    const priced = evaluateModelCall(
      context({ budget, pricing: PRICED }),
      reservation({ estimatedInputTokens: 1_000_000, estimatedOutputTokens: 1_000_000 }),
    );
    expect(priced.allowed === false && priced.reason).toMatch(/Estimated-cost budget/);

    const unpriced = evaluateModelCall(
      context({ budget, pricing: UNPRICED }),
      reservation({ estimatedInputTokens: 1_000_000, estimatedOutputTokens: 1_000_000 }),
    );
    expect(unpriced.allowed).toBe(true);
  });

  it("denies after the wall-clock budget elapses", () => {
    const decision = evaluateModelCall(
      context({
        budget: policy({ maxWallClockMs: 1_000 }),
        state: { wallClockStartedAt: "2026-01-01T00:00:00.000Z" },
        nowMs: Date.parse("2026-01-01T00:00:05.000Z"),
      }),
      reservation(),
    );
    expect(decision.allowed === false && decision.reason).toMatch(/Wall-clock budget/);
  });

  it("stops new work once the orchestration is already exhausted", () => {
    const decision = evaluateModelCall(
      context({ state: { exhaustedReason: "already stopped" } }),
      reservation(),
    );
    expect(decision).toEqual({ allowed: false, reason: "already stopped" });
  });

  it("bounds worker retries per task", () => {
    const budget = policy({ maxWorkerAttempts: 2 });
    const state = { workerAttemptsByTask: { "task-1": 2 } };
    expect(evaluateWorkerAttempt(context({ budget, state }), "task-1").allowed).toBe(false);
    expect(evaluateWorkerAttempt(context({ budget, state }), "task-2").allowed).toBe(true);

    const call = evaluateModelCall(
      context({ budget, state }),
      reservation({ role: "worker", taskId: "task-1", modelId: "worker-model" }),
    );
    expect(call.allowed === false && call.reason).toMatch(/Worker attempt budget/);
  });

  it("bounds context expansions per task separately from retries", () => {
    const budget = policy({ maxContextExpansionsPerTask: 1 });
    expect(
      evaluateContextExpansion(context({ budget, state: { contextExpansionsByTask: {} } }), "task-1")
        .allowed,
    ).toBe(true);
    const denied = evaluateContextExpansion(
      context({ budget, state: { contextExpansionsByTask: { "task-1": 1 } } }),
      "task-1",
    );
    expect(denied.allowed === false && denied.reason).toMatch(/Context expansion budget/);
  });
});

describe("usage ledger", () => {
  it("aggregates by role and in total", () => {
    let ledger = emptyUsageLedger(true);
    ledger = applyUsage(
      ledger,
      "planner",
      "planner-model",
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      PRICED,
    );
    ledger = applyUsage(
      ledger,
      "worker",
      "worker-model",
      { inputTokens: 2_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
      PRICED,
    );
    ledger = applyUsage(
      ledger,
      "worker",
      "worker-model",
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 },
      PRICED,
    );

    expect(ledger.byRole.planner?.modelCalls).toBe(1);
    expect(ledger.byRole.worker?.modelCalls).toBe(2);
    expect(ledger.totalInputTokens).toBe(3_000_000);
    expect(ledger.totalOutputTokens).toBe(2_000_000);
    expect(ledger.byRole.planner?.estimatedUsd).toBe(10);
    expect(ledger.byRole.worker?.estimatedUsd).toBe(8);
    expect(ledger.totalEstimatedUsd).toBe(18);
    expect(ledger.pricingStatus).toBe("configured");
  });

  it("keeps dollars null and pricing unknown when any used model is unpriced", () => {
    let ledger = emptyUsageLedger(true);
    ledger = applyUsage(
      ledger,
      "planner",
      "planner-model",
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      PRICED,
    );
    ledger = applyUsage(
      ledger,
      "verifier",
      "mystery-model",
      { inputTokens: 500, cachedInputTokens: 0, outputTokens: 500 },
      PRICED,
    );
    expect(ledger.byRole.verifier?.estimatedUsd).toBeNull();
    expect(ledger.totalEstimatedUsd).toBeNull();
    expect(ledger.pricingStatus).toBe("unknown");
    expect(ledger.totalInputTokens).toBe(1_000_500);
  });

  it("starts unknown when no pricing at all is configured", () => {
    expect(emptyUsageLedger(false)).toMatchObject({
      totalEstimatedUsd: null,
      pricingStatus: "unknown",
    });
  });

  it("rejects negative, NaN and infinite token counts", () => {
    expect(
      normalizeTokenUsage({
        inputTokens: -5,
        cachedInputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(normalizeTokenUsage(null)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("budget overrides", () => {
  it("falls back to defaults for missing, negative, NaN and infinite values", () => {
    const normalized = normalizeBudgetPolicy({
      maxModelCalls: -3,
      maxSteps: Number.NaN,
      maxWallClockMs: Number.POSITIVE_INFINITY,
    });
    expect(normalized.maxModelCalls).toBe(DEFAULT_BUDGET_POLICY.maxModelCalls);
    expect(normalized.maxSteps).toBe(DEFAULT_BUDGET_POLICY.maxSteps);
    expect(normalized.maxWallClockMs).toBe(DEFAULT_BUDGET_POLICY.maxWallClockMs);
  });

  it("clamps unreasonably large values to the enforceable ceiling", () => {
    const normalized = normalizeBudgetPolicy({
      maxInputTokens: 999_999_999_999,
      maxModelCalls: 1_000_000,
    });
    expect(normalized.maxInputTokens).toBe(BUDGET_LIMITS.maxInputTokens);
    expect(normalized.maxModelCalls).toBe(BUDGET_LIMITS.maxModelCalls);
  });

  it("keeps an explicit null as no limit and applies real overrides", () => {
    const normalized = normalizeBudgetPolicy({
      maxInputTokens: null,
      maxWorkerAttempts: 2,
    });
    expect(normalized.maxInputTokens).toBeNull();
    expect(normalized.maxWorkerAttempts).toBe(2);
  });
});
