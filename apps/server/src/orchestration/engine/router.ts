import type {
  BudgetPolicy,
  RequestedExecutionMode,
  SelectedExecutionMode,
} from "../contracts.js";

export interface RoutingFacts {
  requestedMode: RequestedExecutionMode;
  taskCount: number;
  changedAreaCount: number;
  coupling: "low" | "medium" | "high";
  estimatedCalls: number;
  estimatedContextTokens: number;
  budget: BudgetPolicy;
}

export interface RouteDecision {
  selectedMode: SelectedExecutionMode;
  reason: string;
}

export function selectRoute(facts: RoutingFacts): RouteDecision {
  if (facts.estimatedCalls > facts.budget.maxModelCalls) {
    throw new Error("The confirmed work cannot fit within the model-call budget");
  }
  if (
    facts.budget.maxInputTokens !== null &&
    facts.estimatedContextTokens > facts.budget.maxInputTokens
  ) {
    throw new Error("The confirmed work cannot fit within the input-token budget");
  }
  if (facts.requestedMode === "direct") {
    return { selectedMode: "direct", reason: "The user explicitly selected direct execution" };
  }
  if (facts.taskCount <= 1 || facts.coupling === "high") {
    return {
      selectedMode: facts.requestedMode === "orchestrated" ? "one-worker" : "direct",
      reason:
        facts.coupling === "high"
          ? "The work is tightly coupled, so parallel coordination would add risk"
          : "The work is small enough that delegation overhead is not justified",
    };
  }
  if (facts.requestedMode === "orchestrated" || (facts.taskCount >= 2 && facts.changedAreaCount >= 2)) {
    return {
      selectedMode: "multi-worker",
      reason: "Independent areas can be isolated and verified with bounded coordination",
    };
  }
  return {
    selectedMode: "one-worker",
    reason: "One focused worker balances context isolation and coordination overhead",
  };
}
