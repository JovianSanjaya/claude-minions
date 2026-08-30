import type {
  BudgetPolicy,
  ModelCallReservation,
  ModelRole,
  RoleUsage,
  TokenUsage,
  UsageLedger,
} from "../contracts.js";
import type { BudgetState } from "./store.js";

/**
 * Budget gate and usage ledger.
 *
 * All functions here are pure so the decisions can be unit tested without a
 * filesystem, a driver or a clock. The control service owns persistence and
 * event emission; this module owns arithmetic and policy.
 *
 * Estimated dollars are always `null` when pricing for the model in question
 * is not configured. A dollar value is never fabricated and is never labelled
 * as billed cost.
 */

export interface ModelPricing {
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

/**
 * Browser-supplied budget overrides. Every field is independently optional and
 * may be explicitly `undefined`, unlike `Partial<BudgetPolicy>` under
 * `exactOptionalPropertyTypes`.
 */
export type BudgetOverrides = {
  [Key in keyof BudgetPolicy]?: BudgetPolicy[Key] | undefined;
};

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  maxInputTokens: 2_000_000,
  maxOutputTokens: 400_000,
  maxEstimatedUsd: null,
  maxModelCalls: 60,
  maxSteps: 400,
  maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 3,
  maxWallClockMs: 900_000,
};

/** Absolute ceilings applied to any browser-supplied budget override. */
export const BUDGET_LIMITS = {
  maxInputTokens: 50_000_000,
  maxOutputTokens: 10_000_000,
  maxEstimatedUsd: 10_000,
  maxModelCalls: 10_000,
  maxSteps: 100_000,
  maxWorkerAttempts: 50,
  maxContextExpansionsPerTask: 100,
  maxWallClockMs: 6 * 60 * 60 * 1_000,
} as const;

export class PricingBook {
  constructor(private readonly table: PricingTable = {}) {}

  /** True when at least one model has configured pricing. */
  get isConfigured(): boolean {
    return Object.keys(this.table).length > 0;
  }

  has(modelId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.table, modelId);
  }

  /** Returns `null` for an unpriced model rather than guessing a value. */
  estimateUsd(modelId: string, usage: TokenUsage): number | null {
    const pricing = this.table[modelId];
    if (!pricing) {
      return null;
    }
    const perMillion = (tokens: number, rate: number): number =>
      (Math.max(0, tokens) / 1_000_000) * Math.max(0, rate);
    const total =
      perMillion(usage.inputTokens, pricing.inputUsdPerMillionTokens) +
      perMillion(usage.cachedInputTokens, pricing.cachedInputUsdPerMillionTokens) +
      perMillion(usage.outputTokens, pricing.outputUsdPerMillionTokens);
    return Number(total.toFixed(6));
  }
}

export type BudgetEvaluation =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface BudgetContext {
  budget: BudgetPolicy;
  usage: UsageLedger;
  state: BudgetState;
  pricing: PricingBook;
  nowMs: number;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function normalizeTokenUsage(usage: Partial<TokenUsage> | null | undefined): TokenUsage {
  return {
    inputTokens: safeCount(usage?.inputTokens),
    cachedInputTokens: safeCount(usage?.cachedInputTokens),
    outputTokens: safeCount(usage?.outputTokens),
  };
}

export function emptyUsageLedger(pricingConfigured: boolean): UsageLedger {
  return {
    byRole: {},
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedUsd: pricingConfigured ? 0 : null,
    pricingStatus: pricingConfigured ? "configured" : "unknown",
  };
}

export function createBudgetState(
  orchestrationId: string,
  startedAt: string | null,
): BudgetState {
  return {
    orchestrationId,
    modelCalls: 0,
    steps: 0,
    workerAttemptsByTask: {},
    contextExpansionsByTask: {},
    reservations: [],
    wallClockStartedAt: startedAt,
    exhaustedReason: null,
  };
}

/** Sum of the still-open reservations, used as a conservative headroom check. */
export function openReservationTotals(
  state: BudgetState,
  pricing: PricingBook,
): { inputTokens: number; outputTokens: number; estimatedUsd: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;
  for (const reservation of state.reservations) {
    if (reservation.status !== "open") {
      continue;
    }
    inputTokens += reservation.estimatedInputTokens;
    outputTokens += reservation.estimatedOutputTokens;
    const cost = pricing.estimateUsd(reservation.modelId, {
      inputTokens: reservation.estimatedInputTokens,
      cachedInputTokens: 0,
      outputTokens: reservation.estimatedOutputTokens,
    });
    estimatedUsd += cost ?? 0;
  }
  return { inputTokens, outputTokens, estimatedUsd };
}

function evaluateWallClock(context: BudgetContext): BudgetEvaluation {
  const { state, budget, nowMs } = context;
  if (!state.wallClockStartedAt) {
    return { allowed: true };
  }
  const startedMs = Date.parse(state.wallClockStartedAt);
  if (!Number.isFinite(startedMs)) {
    return { allowed: true };
  }
  const elapsed = nowMs - startedMs;
  if (elapsed > budget.maxWallClockMs) {
    return {
      allowed: false,
      reason:
        "Wall-clock budget exhausted: " +
        elapsed +
        "ms elapsed of " +
        budget.maxWallClockMs +
        "ms",
    };
  }
  return { allowed: true };
}

/**
 * Decides whether one more model call may start. The check is conservative:
 * the reservation's own estimate plus every still-open reservation is counted
 * against the limits before any of them have reported real usage.
 */
export function evaluateModelCall(
  context: BudgetContext,
  reservation: ModelCallReservation,
): BudgetEvaluation {
  const { budget, usage, state, pricing } = context;
  if (state.exhaustedReason) {
    return { allowed: false, reason: state.exhaustedReason };
  }

  const wallClock = evaluateWallClock(context);
  if (!wallClock.allowed) {
    return wallClock;
  }

  if (state.modelCalls + 1 > budget.maxModelCalls) {
    return {
      allowed: false,
      reason:
        "Model-call budget exhausted: " +
        state.modelCalls +
        " of " +
        budget.maxModelCalls +
        " calls already used",
    };
  }

  if (state.steps + 1 > budget.maxSteps) {
    return {
      allowed: false,
      reason:
        "Step budget exhausted: " +
        state.steps +
        " of " +
        budget.maxSteps +
        " steps already used",
    };
  }

  const estimatedInput = safeCount(reservation.estimatedInputTokens);
  const estimatedOutput = safeCount(reservation.estimatedOutputTokens);
  const open = openReservationTotals(state, pricing);

  if (budget.maxInputTokens !== null) {
    const projected = usage.totalInputTokens + open.inputTokens + estimatedInput;
    if (projected > budget.maxInputTokens) {
      return {
        allowed: false,
        reason:
          "Input-token budget exhausted: projected " +
          projected +
          " of " +
          budget.maxInputTokens,
      };
    }
  }

  if (budget.maxOutputTokens !== null) {
    const projected = usage.totalOutputTokens + open.outputTokens + estimatedOutput;
    if (projected > budget.maxOutputTokens) {
      return {
        allowed: false,
        reason:
          "Output-token budget exhausted: projected " +
          projected +
          " of " +
          budget.maxOutputTokens,
      };
    }
  }

  if (budget.maxEstimatedUsd !== null) {
    const reservationCost = pricing.estimateUsd(reservation.modelId, {
      inputTokens: estimatedInput,
      cachedInputTokens: 0,
      outputTokens: estimatedOutput,
    });
    // With unknown pricing the dollar limit cannot be enforced; the token and
    // call limits remain the effective bound and the caller records that.
    if (reservationCost !== null) {
      const projected =
        (usage.totalEstimatedUsd ?? 0) + open.estimatedUsd + reservationCost;
      if (projected > budget.maxEstimatedUsd) {
        return {
          allowed: false,
          reason:
            "Estimated-cost budget exhausted: projected estimated cost " +
            projected.toFixed(4) +
            " USD of " +
            budget.maxEstimatedUsd +
            " USD",
        };
      }
    }
  }

  if (reservation.role === "worker" && reservation.taskId) {
    const attempts = safeCount(state.workerAttemptsByTask[reservation.taskId]);
    if (attempts >= budget.maxWorkerAttempts) {
      return {
        allowed: false,
        reason:
          "Worker attempt budget exhausted for task " +
          reservation.taskId +
          ": " +
          attempts +
          " of " +
          budget.maxWorkerAttempts,
      };
    }
  }

  return { allowed: true };
}

/** Decides whether one more bounded worker attempt may start for a task. */
export function evaluateWorkerAttempt(
  context: BudgetContext,
  taskId: string,
): BudgetEvaluation {
  const { budget, state } = context;
  if (state.exhaustedReason) {
    return { allowed: false, reason: state.exhaustedReason };
  }
  const wallClock = evaluateWallClock(context);
  if (!wallClock.allowed) {
    return wallClock;
  }
  const attempts = safeCount(state.workerAttemptsByTask[taskId]);
  if (attempts + 1 > budget.maxWorkerAttempts) {
    return {
      allowed: false,
      reason:
        "Worker attempt budget exhausted for task " +
        taskId +
        ": " +
        attempts +
        " of " +
        budget.maxWorkerAttempts,
    };
  }
  return { allowed: true };
}

/** Decides whether one more narrow context expansion may be granted. */
export function evaluateContextExpansion(
  context: BudgetContext,
  taskId: string,
): BudgetEvaluation {
  const { budget, state } = context;
  if (state.exhaustedReason) {
    return { allowed: false, reason: state.exhaustedReason };
  }
  const wallClock = evaluateWallClock(context);
  if (!wallClock.allowed) {
    return wallClock;
  }
  const expansions = safeCount(state.contextExpansionsByTask[taskId]);
  if (expansions + 1 > budget.maxContextExpansionsPerTask) {
    return {
      allowed: false,
      reason:
        "Context expansion budget exhausted for task " +
        taskId +
        ": " +
        expansions +
        " of " +
        budget.maxContextExpansionsPerTask,
    };
  }
  return { allowed: true };
}

/**
 * Attributes actual usage to a logical role and recomputes totals.
 *
 * `totalEstimatedUsd` stays `null` unless every role that has recorded usage
 * has configured pricing, so a partially-priced run is reported honestly as
 * unknown rather than as an understated dollar figure.
 */
export function applyUsage(
  ledger: UsageLedger,
  role: ModelRole,
  modelId: string,
  actual: TokenUsage,
  pricing: PricingBook,
): UsageLedger {
  const usage = normalizeTokenUsage(actual);
  const previous = ledger.byRole[role];
  const merged: RoleUsage = {
    modelId,
    inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + usage.cachedInputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
    modelCalls: (previous?.modelCalls ?? 0) + 1,
    estimatedUsd: null,
  };
  merged.estimatedUsd = pricing.estimateUsd(modelId, {
    inputTokens: merged.inputTokens,
    cachedInputTokens: merged.cachedInputTokens,
    outputTokens: merged.outputTokens,
  });

  const byRole: UsageLedger["byRole"] = { ...ledger.byRole, [role]: merged };

  let totalInputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedUsd = 0;
  let allPriced = true;
  for (const entry of Object.values(byRole)) {
    if (!entry) {
      continue;
    }
    totalInputTokens += entry.inputTokens;
    totalCachedInputTokens += entry.cachedInputTokens;
    totalOutputTokens += entry.outputTokens;
    if (entry.estimatedUsd === null) {
      allPriced = false;
    } else {
      totalEstimatedUsd += entry.estimatedUsd;
    }
  }

  return {
    byRole,
    totalInputTokens,
    totalCachedInputTokens,
    totalOutputTokens,
    totalEstimatedUsd: allPriced ? Number(totalEstimatedUsd.toFixed(6)) : null,
    pricingStatus: allPriced ? "configured" : "unknown",
  };
}

/** Clamps a browser-supplied budget override into the enforceable range. */
export function normalizeBudgetPolicy(
  overrides: BudgetOverrides | undefined,
  defaults: BudgetPolicy = DEFAULT_BUDGET_POLICY,
): BudgetPolicy {
  const nullableCeiling = (
    value: number | null | undefined,
    fallback: number | null,
    ceiling: number,
  ): number | null => {
    if (value === undefined) {
      return fallback;
    }
    if (value === null) {
      return null;
    }
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.min(value, ceiling);
  };
  const positive = (
    value: number | undefined,
    fallback: number,
    ceiling: number,
    minimum = 1,
  ): number => {
    if (value === undefined || !Number.isFinite(value) || value < minimum) {
      return fallback;
    }
    return Math.min(Math.floor(value), ceiling);
  };

  return {
    maxInputTokens: nullableCeiling(
      overrides?.maxInputTokens,
      defaults.maxInputTokens,
      BUDGET_LIMITS.maxInputTokens,
    ),
    maxOutputTokens: nullableCeiling(
      overrides?.maxOutputTokens,
      defaults.maxOutputTokens,
      BUDGET_LIMITS.maxOutputTokens,
    ),
    maxEstimatedUsd: nullableCeiling(
      overrides?.maxEstimatedUsd,
      defaults.maxEstimatedUsd,
      BUDGET_LIMITS.maxEstimatedUsd,
    ),
    maxModelCalls: positive(
      overrides?.maxModelCalls,
      defaults.maxModelCalls,
      BUDGET_LIMITS.maxModelCalls,
    ),
    maxSteps: positive(overrides?.maxSteps, defaults.maxSteps, BUDGET_LIMITS.maxSteps),
    maxWorkerAttempts: positive(
      overrides?.maxWorkerAttempts,
      defaults.maxWorkerAttempts,
      BUDGET_LIMITS.maxWorkerAttempts,
    ),
    maxContextExpansionsPerTask: positive(
      overrides?.maxContextExpansionsPerTask,
      defaults.maxContextExpansionsPerTask,
      BUDGET_LIMITS.maxContextExpansionsPerTask,
      0,
    ),
    maxWallClockMs: positive(
      overrides?.maxWallClockMs,
      defaults.maxWallClockMs,
      BUDGET_LIMITS.maxWallClockMs,
      1_000,
    ),
  };
}
