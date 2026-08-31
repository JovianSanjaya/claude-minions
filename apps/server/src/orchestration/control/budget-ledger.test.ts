import { describe, expect, it } from "vitest";
import type { ModelCallReservation, Orchestration } from "../contracts.js";
import {
  actualUsageCost,
  commitUsageToDatabase,
  decideReservation,
  estimateExceedsBudget,
  type ModelPricing,
} from "./budget-ledger.js";
import { emptyOrchestrationDatabase } from "./store.js";

const pricing: ModelPricing[] = [{
  role: "worker",
  modelId: "cheap-model",
  inputUsdPerMillion: 1,
  cachedInputUsdPerMillion: 0.1,
  outputUsdPerMillion: 2,
}];

const orchestration = (): Orchestration => ({
  id: "o1", agentId: "a1", prompt: "work", requestedMode: "auto",
  selectedMode: null, status: "running", currentIntentDraftId: null,
  activeContractId: null, estimate: null,
  budget: {
    maxInputTokens: 1_000, maxOutputTokens: 1_000, maxEstimatedUsd: 1,
    maxModelCalls: 2, maxSteps: 10, maxWorkerAttempts: 2,
    maxContextExpansionsPerTask: 1,
  },
  usage: {
    byRole: {}, totalInputTokens: 0, totalCachedInputTokens: 0,
    totalOutputTokens: 0, totalEstimatedUsd: 0, pricingStatus: "configured",
  },
  finalOutput: null, error: null, createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(), completedAt: null,
});

const reservation: ModelCallReservation = {
  orchestrationId: "o1", taskId: "t1", executionId: "e1", role: "worker",
  modelId: "cheap-model", estimatedInputTokens: 500, estimatedOutputTokens: 100,
};

describe("budget ledger", () => {
  it("blocks confirmation when the low estimate cannot fit the hard budget", () => {
    const item = orchestration();
    expect(
      estimateExceedsBudget(
        { inputTokenLow: 1_001, outputTokenLow: 1, estimatedUsdLow: null },
        item.budget,
      ),
    ).toBe("Estimated input tokens already exceed the configured hard budget");
    expect(
      estimateExceedsBudget(
        { inputTokenLow: 100, outputTokenLow: 100, estimatedUsdLow: null },
        item.budget,
      ),
    ).toBeNull();
  });

  it("gates token, call, and cost reservations without an elapsed-time cutoff", () => {
    const item = orchestration();
    expect(decideReservation(item, [], reservation, pricing).decision.allowed).toBe(true);
    item.budget.maxInputTokens = 499;
    expect(decideReservation(item, [], reservation, pricing).decision).toMatchObject({
      allowed: false, reason: "Input-token budget exhausted",
    });
    item.budget.maxInputTokens = 1_000;
    item.createdAt = new Date(0).toISOString();
    expect(decideReservation(item, [], reservation, pricing).decision.allowed).toBe(true);
  });

  it("aggregates actual role and total usage with configured pricing", () => {
    const database = emptyOrchestrationDatabase();
    database.orchestrations.push(orchestration());
    database.reservations.push({
      ...reservation, id: "r1", estimatedUsd: 0.0007, createdAt: new Date(0).toISOString(),
    });
    commitUsageToDatabase(database, "r1", {
      inputTokens: 400, cachedInputTokens: 100, outputTokens: 50,
    }, pricing);
    expect(database.orchestrations[0]!.usage).toMatchObject({
      totalInputTokens: 400, totalCachedInputTokens: 100, totalOutputTokens: 50,
      pricingStatus: "configured",
      byRole: { worker: { modelCalls: 1, estimatedUsd: 0.00041 } },
    });
    expect(actualUsageCost({ inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 }, "worker", "unknown", pricing)).toBeNull();
  });

  it("preserves unknown pricing instead of fabricating dollars", () => {
    const database = emptyOrchestrationDatabase();
    const item = orchestration();
    item.usage.totalEstimatedUsd = null;
    item.usage.pricingStatus = "unknown";
    database.orchestrations.push(item);
    database.reservations.push({
      ...reservation, id: "r1", modelId: "unpriced", estimatedUsd: null,
      createdAt: new Date(0).toISOString(),
    });
    commitUsageToDatabase(database, "r1", {
      inputTokens: 1, cachedInputTokens: 0, outputTokens: 1,
    }, pricing);
    expect(item.usage.byRole.worker?.estimatedUsd).toBeNull();
    expect(item.usage.totalEstimatedUsd).toBeNull();
    expect(item.usage.pricingStatus).toBe("unknown");
  });
});
