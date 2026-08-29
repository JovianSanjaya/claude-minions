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
    (usage.inputTokens * rate.inputUsdPerMillion +
      usage.cachedInputTokens * rate.cachedInputUsdPerMillion +
      usage.outputTokens * rate.outputUsdPerMillion) /
    1_000_000
  );
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
  nowMs: number,
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

  if (nowMs - Date.parse(orchestration.createdAt) >= orchestration.budget.maxWallClockMs) {
    return deny("Wall-clock budget exhausted");
  }
  if (modelCallCount(orchestration) + active.length + 1 > orchestration.budget.maxModelCalls) {
    return deny("Model-call budget exhausted");
  }
  if (
    orchestration.budget.maxInputTokens !== null &&
    orchestration.usage.totalInputTokens +
      orchestration.usage.totalCachedInputTokens +
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
  };
  orchestration.usage.byRole[reservation.role] = roleUsage;
  orchestration.usage.totalInputTokens += actual.inputTokens;
  orchestration.usage.totalCachedInputTokens += actual.cachedInputTokens;
  orchestration.usage.totalOutputTokens += actual.outputTokens;
  if (orchestration.usage.totalEstimatedUsd === null || cost === null) {
    orchestration.usage.totalEstimatedUsd = null;
    orchestration.usage.pricingStatus = "unknown";
  } else {
    orchestration.usage.totalEstimatedUsd += cost;
  }
  database.reservations.splice(reservationIndex, 1);
}
