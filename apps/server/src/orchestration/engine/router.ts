import type {
  BudgetPolicy,
  RequestedExecutionMode,
  SelectedExecutionMode,
} from "../contracts.js";

/**
 * Adaptive routing between direct, one-worker, and multi-worker execution.
 *
 * The decision is a deterministic, inspectable function of measured signals -
 * size, modularity, coupling, context breadth, likely retries, coordination
 * overhead, and the hard budget - so a route can always be explained.
 */

export interface RouteSignals {
  requestedMode: RequestedExecutionMode;
  /** Candidate subtasks the planner proposed. */
  proposedTaskCount: number;
  /** Distinct top-level areas the proposed tasks touch. */
  distinctAreas: number;
  /** Allowed-path entries claimed by more than one proposed task. */
  overlappingPathCount: number;
  /** Total allowed-path entries across proposed tasks. */
  totalPathCount: number;
  /** Files the whole contract is expected to need as context. */
  contextFileCount: number;
  /** Files in the versioned application map. */
  mapFileCount: number;
  /** Whether the planner believes the contract can be split at all. */
  decomposable: boolean;
  budget: BudgetPolicy;
}

export interface RouteScores {
  couplingRatio: number;
  breadthScore: number;
  estimatedCallsDirect: number;
  estimatedCallsOneWorker: number;
  estimatedCallsMultiWorker: number;
}

export type RouteDecision =
  | { ok: true; mode: SelectedExecutionMode; reason: string; scores: RouteScores }
  | { ok: false; reason: string; scores: RouteScores };

/** Planner + verifier + integrator overhead in model calls. */
const COORDINATION_CALLS = 4;
/** preflight + write + local diagnosis per worker task, allowing one retry. */
const CALLS_PER_TASK = 4;

export function estimateRouteCalls(signals: RouteSignals): RouteScores {
  const taskCount = Math.max(1, signals.proposedTaskCount);
  const couplingRatio =
    signals.totalPathCount > 0
      ? signals.overlappingPathCount / signals.totalPathCount
      : 0;
  const breadthScore =
    signals.mapFileCount > 0
      ? Math.min(1, signals.contextFileCount / Math.max(1, signals.mapFileCount))
      : 0;
  return {
    couplingRatio: Number(couplingRatio.toFixed(3)),
    breadthScore: Number(breadthScore.toFixed(3)),
    estimatedCallsDirect: 1 + COORDINATION_CALLS,
    estimatedCallsOneWorker: CALLS_PER_TASK + COORDINATION_CALLS,
    estimatedCallsMultiWorker: taskCount * CALLS_PER_TASK + COORDINATION_CALLS,
  };
}

export function decideRoute(signals: RouteSignals): RouteDecision {
  const scores = estimateRouteCalls(signals);
  const budgetCalls = signals.budget.maxModelCalls;
  const fits = (calls: number) => calls <= budgetCalls;

  if (signals.requestedMode === "direct") {
    if (!fits(scores.estimatedCallsDirect)) {
      return {
        ok: false,
        reason:
          "Direct execution needs about " +
          scores.estimatedCallsDirect +
          " model calls but the hard budget allows " +
          budgetCalls,
        scores,
      };
    }
    return {
      ok: true,
      mode: "direct",
      reason: "The user requested direct execution",
      scores,
    };
  }

  const tiny =
    signals.proposedTaskCount <= 1 ||
    signals.contextFileCount <= 2 ||
    signals.totalPathCount <= 1;
  const tightlyCoupled = scores.couplingRatio >= 0.4;
  const modular =
    signals.decomposable &&
    signals.proposedTaskCount >= 2 &&
    signals.distinctAreas >= 2 &&
    !tightlyCoupled;

  if (signals.requestedMode === "orchestrated") {
    if (!signals.decomposable) {
      return {
        ok: false,
        reason:
          "Delegation was requested but the confirmed contract is not decomposable into independent tasks",
        scores,
      };
    }
    if (modular && fits(scores.estimatedCallsMultiWorker)) {
      return {
        ok: true,
        mode: "multi-worker",
        reason:
          "Delegation requested: " +
          signals.proposedTaskCount +
          " tasks across " +
          signals.distinctAreas +
          " areas with low coupling (" +
          scores.couplingRatio +
          ")",
        scores,
      };
    }
    if (fits(scores.estimatedCallsOneWorker)) {
      return {
        ok: true,
        mode: "one-worker",
        reason: modular
          ? "Delegation requested but the hard budget only affords one focused worker"
          : "Delegation requested; the work is small or tightly coupled, so one focused worker is used",
        scores,
      };
    }
    return {
      ok: false,
      reason:
        "Delegation was requested but even one focused worker needs about " +
        scores.estimatedCallsOneWorker +
        " model calls against a hard budget of " +
        budgetCalls,
      scores,
    };
  }

  // requestedMode === "auto"
  if (tiny && fits(scores.estimatedCallsDirect)) {
    return {
      ok: true,
      mode: "direct",
      reason:
        "Small or single-task work (" +
        signals.proposedTaskCount +
        " task(s), " +
        signals.contextFileCount +
        " context files): direct execution avoids coordination overhead",
      scores,
    };
  }
  if (modular && fits(scores.estimatedCallsMultiWorker)) {
    return {
      ok: true,
      mode: "multi-worker",
      reason:
        signals.proposedTaskCount +
        " modular tasks across " +
        signals.distinctAreas +
        " areas with coupling ratio " +
        scores.couplingRatio +
        ": parallel focused workers keep each context narrow",
      scores,
    };
  }
  if (fits(scores.estimatedCallsOneWorker)) {
    return {
      ok: true,
      mode: "one-worker",
      reason: tightlyCoupled
        ? "Tasks share " +
          signals.overlappingPathCount +
          " of " +
          signals.totalPathCount +
          " paths (coupling " +
          scores.couplingRatio +
          "): one focused worker avoids merge conflicts"
        : "Work is moderate but not cleanly separable: one focused worker",
      scores,
    };
  }
  if (fits(scores.estimatedCallsDirect)) {
    return {
      ok: true,
      mode: "direct",
      reason:
        "The hard budget of " +
        budgetCalls +
        " model calls cannot afford worker coordination, so execution stays direct",
      scores,
    };
  }
  return {
    ok: false,
    reason:
      "The hard budget of " +
      budgetCalls +
      " model calls cannot afford any execution mode",
    scores,
  };
}
