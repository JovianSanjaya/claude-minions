import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  BudgetDecision,
  BudgetPolicy,
  ModelRole,
  ModelCallReservation,
  RoleUsage,
  TokenUsage,
  UsageLedger,
} from "../contracts.js";

export const budgetPolicySchema = z
  .object({
    maxInputTokens: z.number().int().positive().finite().nullable().default(null),
    maxOutputTokens: z.number().int().positive().finite().nullable().default(null),
    maxEstimatedUsd: z.number().positive().finite().nullable().default(null),
    maxModelCalls: z.number().int().positive().max(500).default(40),
    maxSteps: z.number().int().positive().max(500).default(40),
    maxWorkerAttempts: z.number().int().positive().max(10).default(3),
    maxContextExpansionsPerTask: z.number().int().min(0).max(20).default(3),
    maxWallClockMs: z
      .number()
      .int()
      .positive()
      .max(4 * 60 * 60 * 1000)
      .default(20 * 60 * 1000),
  })
  .strict();

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = budgetPolicySchema.parse({});

export function parseBudgetPolicy(input: unknown): BudgetPolicy {
  return budgetPolicySchema.parse(input ?? {});
}

export const budgetPolicyOverrideSchema = budgetPolicySchema.partial();
export type BudgetPolicyOverride = z.infer<typeof budgetPolicyOverrideSchema>;

export interface RolePricing {
  inputPerToken: number;
  cachedInputPerToken: number;
  outputPerToken: number;
}

export type PricingTable = Partial<Record<ModelRole, RolePricing>>;

export function createEmptyUsageLedger(): UsageLedger {
  return {
    byRole: {},
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedUsd: null,
    pricingStatus: "unknown",
  };
}

function costOf(usage: TokenUsage, rate: RolePricing): number {
  return (
    usage.inputTokens * rate.inputPerToken +
    usage.cachedInputTokens * rate.cachedInputPerToken +
    usage.outputTokens * rate.outputPerToken
  );
}

/**
 * Checks a proposed model call against the orchestration's remaining budget
 * without mutating any state. The caller commits the reservation id via
 * `commitModelUsage` only once the call actually completes, so denied or
 * abandoned calls never inflate the ledger.
 */
export function reserveModelCall(
  current: UsageLedger,
  budget: BudgetPolicy,
  reservation: Pick<
    ModelCallReservation,
    "role" | "modelId" | "estimatedInputTokens" | "estimatedOutputTokens"
  >,
  pricing?: PricingTable,
): BudgetDecision {
  const totalCallsSoFar = Object.values(current.byRole).reduce(
    (sum, role) => sum + (role?.modelCalls ?? 0),
    0,
  );
  if (totalCallsSoFar + 1 > budget.maxModelCalls) {
    return { allowed: false, reason: "Model call budget exhausted" };
  }

  const projectedInputTokens = current.totalInputTokens + reservation.estimatedInputTokens;
  if (budget.maxInputTokens !== null && projectedInputTokens > budget.maxInputTokens) {
    return { allowed: false, reason: "Input token budget exhausted" };
  }

  const projectedOutputTokens = current.totalOutputTokens + reservation.estimatedOutputTokens;
  if (budget.maxOutputTokens !== null && projectedOutputTokens > budget.maxOutputTokens) {
    return { allowed: false, reason: "Output token budget exhausted" };
  }

  const rate = pricing?.[reservation.role];
  if (budget.maxEstimatedUsd !== null && rate) {
    const estimatedCallCost = costOf(
      {
        inputTokens: reservation.estimatedInputTokens,
        cachedInputTokens: 0,
        outputTokens: reservation.estimatedOutputTokens,
      },
      rate,
    );
    const projectedCost = (current.totalEstimatedUsd ?? 0) + estimatedCallCost;
    if (projectedCost > budget.maxEstimatedUsd) {
      return { allowed: false, reason: "Estimated dollar budget exhausted" };
    }
  }

  return { allowed: true, reservationId: randomUUID() };
}

/**
 * Applies actual usage for a committed reservation. Pure function: returns a
 * new ledger rather than mutating `current`, so callers stay in control of
 * when the result is persisted.
 */
export function commitModelUsage(
  current: UsageLedger,
  role: ModelRole,
  modelId: string,
  actual: TokenUsage,
  pricing?: PricingTable,
): UsageLedger {
  const existing: RoleUsage = current.byRole[role] ?? {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    modelId,
    estimatedUsd: pricing?.[role] ? 0 : null,
    modelCalls: 0,
  };

  const mergedTokens: TokenUsage = {
    inputTokens: existing.inputTokens + actual.inputTokens,
    cachedInputTokens: existing.cachedInputTokens + actual.cachedInputTokens,
    outputTokens: existing.outputTokens + actual.outputTokens,
  };

  const rate = pricing?.[role];
  const updatedRole: RoleUsage = {
    ...mergedTokens,
    modelId,
    modelCalls: existing.modelCalls + 1,
    estimatedUsd: rate ? costOf(mergedTokens, rate) : null,
  };

  const byRole = { ...current.byRole, [role]: updatedRole };
  const roles = Object.values(byRole) as RoleUsage[];
  const allRolesPriced = roles.every((entry) => entry.estimatedUsd !== null);

  return {
    byRole,
    totalInputTokens: current.totalInputTokens + actual.inputTokens,
    totalCachedInputTokens: current.totalCachedInputTokens + actual.cachedInputTokens,
    totalOutputTokens: current.totalOutputTokens + actual.outputTokens,
    totalEstimatedUsd: allRolesPriced
      ? roles.reduce((sum, entry) => sum + (entry.estimatedUsd ?? 0), 0)
      : null,
    pricingStatus: allRolesPriced ? "configured" : "unknown",
  };
}

/**
 * Compares a pre-confirmation cost estimate against the orchestration's hard
 * budget. Used to deny (rather than silently accept) intents that are
 * already known to exceed the user's stated limits before any model spend
 * has happened.
 */
export function estimateExceedsBudget(
  estimate: { inputTokenLow: number; outputTokenLow: number; estimatedUsdLow: number | null },
  budget: BudgetPolicy,
): string | null {
  if (budget.maxInputTokens !== null && estimate.inputTokenLow > budget.maxInputTokens) {
    return "Estimated input tokens already exceed the configured hard budget";
  }
  if (budget.maxOutputTokens !== null && estimate.outputTokenLow > budget.maxOutputTokens) {
    return "Estimated output tokens already exceed the configured hard budget";
  }
  if (
    budget.maxEstimatedUsd !== null &&
    estimate.estimatedUsdLow !== null &&
    estimate.estimatedUsdLow > budget.maxEstimatedUsd
  ) {
    return "Estimated dollar cost already exceeds the configured hard budget";
  }
  return null;
}
