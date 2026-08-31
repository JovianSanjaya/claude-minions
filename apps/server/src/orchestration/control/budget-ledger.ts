import type {
  BudgetDecision,
  ModelCallReservation,
  ModelRole,
  Orchestration,
  RoleUsage,
  TokenUsage,
} from "../contracts.js";
import type { OrchestrationDatabase, StoredReservation } from "./store.js";

export interface ModelPricing {
  role: ModelRole;
  modelId: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export class InvalidBudgetValueError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidBudgetValueError";
  }
}

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidBudgetValueError(`${field} must be a non-negative safe integer`);
  }
}

function findPricing(
  pricing: readonly ModelPricing[],
  role: ModelRole,
  modelId: string,
): ModelPricing | undefined {
  return pricing.find((entry) => entry.role === role && entry.modelId === modelId);
}

export function estimatedReservationCost(
  reservation: ModelCallReservation,
  pricing: readonly ModelPricing[],
): number | null {
  const rate = findPricing(pricing, reservation.role, reservation.modelId);
  if (!rate) return null;
  return (
    (reservation.estimatedInputTokens * rate.inputUsdPerMillion +
      reservation.estimatedOutputTokens * rate.outputUsdPerMillion) /
    1_000_000
  );
}

export function actualUsageCost(
  usage: TokenUsage,
  role: ModelRole,
  modelId: string,
  pricing: readonly ModelPricing[],
): number | null {
  const rate = findPricing(pricing, role, modelId);
  if (!rate) return null;
  return (
    ((usage.inputTokens - usage.cachedInputTokens) * rate.inputUsdPerMillion +
      usage.cachedInputTokens * rate.cachedInputUsdPerMillion +
      usage.outputTokens * rate.outputUsdPerMillion) /
    1_000_000
  );
}

/**
 * Rejects confirmation when even the low end of the planner estimate cannot
 * fit inside the already-confirmed hard limits. Unknown dollar pricing is
 * intentionally not treated as zero.
 */
export function estimateExceedsBudget(
  estimate: {
    inputTokenLow: number;
    outputTokenLow: number;
    estimatedUsdLow: number | null;
  },
  budget: Orchestration["budget"],
): string | null {
  if (
    budget.maxInputTokens !== null &&
    estimate.inputTokenLow > budget.maxInputTokens
  ) {
    return "Estimated input tokens already exceed the configured hard budget";
  }
  if (
    budget.maxOutputTokens !== null &&
    estimate.outputTokenLow > budget.maxOutputTokens
  ) {
    return "Estimated output tokens already exceed the configured hard budget";
  }
  if (
    budget.maxEstimatedUsd !== null &&
    estimate.estimatedUsdLow !== null &&
    estimate.estimatedUsdLow > budget.maxEstimatedUsd
  ) {
    return "Estimated cost already exceeds the configured hard budget";
  }
  return null;
}

function modelCallCount(orchestration: Orchestration): number {
  return Object.values(orchestration.usage.byRole).reduce(
    (total, usage) => total + (usage?.modelCalls ?? 0),
    0,
  );
}

export function decideReservation(
  orchestration: Orchestration,
  reservations: readonly StoredReservation[],
  input: ModelCallReservation,
  pricing: readonly ModelPricing[],
): { decision: BudgetDecision; estimatedUsd: number | null } {
  assertCount(input.estimatedInputTokens, "estimatedInputTokens");
  assertCount(input.estimatedOutputTokens, "estimatedOutputTokens");

  const active = reservations.filter(
    (reservation) => reservation.orchestrationId === orchestration.id,
  );
  const reservedInput = active.reduce(
    (total, reservation) => total + reservation.estimatedInputTokens,
    0,
  );
  const reservedOutput = active.reduce(
    (total, reservation) => total + reservation.estimatedOutputTokens,
    0,
  );
  const estimatedUsd = estimatedReservationCost(input, pricing);
  const reservedUsd = active.reduce<number | null>((total, reservation) => {
    if (total === null || reservation.estimatedUsd === null) return null;
    return total + reservation.estimatedUsd;
  }, 0);
  const deny = (reason: string) => ({
    decision: { allowed: false as const, reason },
    estimatedUsd,
  });

  if (modelCallCount(orchestration) + active.length + 1 > orchestration.budget.maxModelCalls) {
    return deny("Model-call budget exhausted");
  }
  if (
    orchestration.budget.maxArkApiTurns !== undefined &&
    (orchestration.usage.totalArkApiTurns ?? 0) >= orchestration.budget.maxArkApiTurns
  ) {
    return deny("Ark-turn budget exhausted");
  }
  if (
    orchestration.budget.maxInputTokens !== null &&
    orchestration.usage.totalInputTokens +
      reservedInput +
      input.estimatedInputTokens >
      orchestration.budget.maxInputTokens
  ) {
    return deny("Input-token budget exhausted");
  }
  if (
    orchestration.budget.maxOutputTokens !== null &&
    orchestration.usage.totalOutputTokens +
      reservedOutput +
      input.estimatedOutputTokens >
      orchestration.budget.maxOutputTokens
  ) {
    return deny("Output-token budget exhausted");
  }
  if (
    orchestration.budget.maxEstimatedUsd !== null &&
    estimatedUsd !== null &&
    orchestration.usage.totalEstimatedUsd !== null &&
    reservedUsd !== null &&
    orchestration.usage.totalEstimatedUsd + reservedUsd + estimatedUsd >
      orchestration.budget.maxEstimatedUsd
  ) {
    return deny("Estimated-cost budget exhausted");
  }
  return {
    decision: { allowed: true, reservationId: "" },
    estimatedUsd,
  };
}

export function commitUsageToDatabase(
  database: OrchestrationDatabase,
  reservationId: string,
  actual: TokenUsage,
  pricing: readonly ModelPricing[],
): void {
  assertCount(actual.inputTokens, "inputTokens");
  assertCount(actual.cachedInputTokens, "cachedInputTokens");
  assertCount(actual.outputTokens, "outputTokens");
  assertCount(actual.arkApiTurns ?? 0, "arkApiTurns");
  assertCount(actual.toolCalls ?? 0, "toolCalls");
  assertCount(actual.streamRetries ?? 0, "streamRetries");
  assertCount(actual.peakContextTokens ?? 0, "peakContextTokens");
  const reservationIndex = database.reservations.findIndex(
    (entry) => entry.id === reservationId,
  );
  if (reservationIndex < 0) {
    throw new InvalidBudgetValueError(`Unknown reservation: ${reservationId}`);
  }
  const reservation = database.reservations[reservationIndex]!;
  const orchestration = database.orchestrations.find(
    (entry) => entry.id === reservation.orchestrationId,
  );
  if (!orchestration) {
    throw new InvalidBudgetValueError("Reservation has no orchestration");
  }
  const completedModelCall = actual.inputTokens > 0 ||
    actual.cachedInputTokens > 0 ||
    actual.outputTokens > 0 ||
    (actual.arkApiTurns ?? 0) > 0 ||
    (actual.toolCalls ?? 0) > 0 ||
    (actual.streamRetries ?? 0) > 0;
  if (!completedModelCall) {
    database.reservations.splice(reservationIndex, 1);
    return;
  }
  const cost = actualUsageCost(
    actual,
    reservation.role,
    reservation.modelId,
    pricing,
  );
  const prior = orchestration.usage.byRole[reservation.role];
  const roleUsage: RoleUsage = {
    modelId:
      !prior || prior.modelId === reservation.modelId
        ? reservation.modelId
        : "mixed",
    inputTokens: (prior?.inputTokens ?? 0) + actual.inputTokens,
    cachedInputTokens:
      (prior?.cachedInputTokens ?? 0) + actual.cachedInputTokens,
    outputTokens: (prior?.outputTokens ?? 0) + actual.outputTokens,
    estimatedUsd:
      prior?.estimatedUsd === null || cost === null
        ? null
        : (prior?.estimatedUsd ?? 0) + cost,
    modelCalls: (prior?.modelCalls ?? 0) + 1,
    arkApiTurns: (prior?.arkApiTurns ?? 0) + (actual.arkApiTurns ?? 0),
    toolCalls: (prior?.toolCalls ?? 0) + (actual.toolCalls ?? 0),
    streamRetries: (prior?.streamRetries ?? 0) + (actual.streamRetries ?? 0),
    peakContextTokens: Math.max(prior?.peakContextTokens ?? 0, actual.peakContextTokens ?? 0),
  };
  orchestration.usage.byRole[reservation.role] = roleUsage;
  orchestration.usage.totalInputTokens += actual.inputTokens;
  orchestration.usage.totalCachedInputTokens += actual.cachedInputTokens;
  orchestration.usage.totalOutputTokens += actual.outputTokens;
  orchestration.usage.totalArkApiTurns =
    (orchestration.usage.totalArkApiTurns ?? 0) + (actual.arkApiTurns ?? 0);
  orchestration.usage.totalToolCalls =
    (orchestration.usage.totalToolCalls ?? 0) + (actual.toolCalls ?? 0);
  orchestration.usage.totalStreamRetries =
    (orchestration.usage.totalStreamRetries ?? 0) + (actual.streamRetries ?? 0);
  orchestration.usage.peakContextTokens = Math.max(
    orchestration.usage.peakContextTokens ?? 0,
    actual.peakContextTokens ?? 0,
  );
  if (orchestration.usage.totalEstimatedUsd === null || cost === null) {
    orchestration.usage.totalEstimatedUsd = null;
    orchestration.usage.pricingStatus = "unknown";
  } else {
    orchestration.usage.totalEstimatedUsd += cost;
  }
  database.reservations.splice(reservationIndex, 1);
}
