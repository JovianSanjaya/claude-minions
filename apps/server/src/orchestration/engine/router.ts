import type {
  BudgetPolicy,
  RequestedExecutionMode,
  SelectedExecutionMode,
} from "../contracts.js";

export interface RoutingFacts {
  requestedMode: RequestedExecutionMode;
  taskCount: number;
  changedAreaCount: number;
  hasOverlappingWriteScopes: boolean;
  coupling: "low" | "medium" | "high";
  estimatedCalls: number;
  estimatedContextTokens: number;
  budget: BudgetPolicy;
}

export interface RouteDecision {
  selectedMode: SelectedExecutionMode;
  reason: string;
}

function normalizedScope(scope: string): string {
  return scope.replace(/^\.\//, "").replace(/\/+$/, "");
}

export interface WriteScopeConflict {
  leftTaskIndex: number;
  leftPath: string;
  rightTaskIndex: number;
  rightPath: string;
}

export function overlappingWriteScopeConflicts(
  tasks: Array<{ allowedPaths: string[] }>,
): WriteScopeConflict[] {
  const conflicts: WriteScopeConflict[] = [];
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      for (const leftValue of tasks[leftIndex]!.allowedPaths) {
        const left = normalizedScope(leftValue);
        for (const rightValue of tasks[rightIndex]!.allowedPaths) {
          const right = normalizedScope(rightValue);
          if (left === right || left.startsWith(right + "/") || right.startsWith(left + "/")) {
            conflicts.push({
              leftTaskIndex: leftIndex,
              leftPath: left,
              rightTaskIndex: rightIndex,
              rightPath: right,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

export function tasksHaveOverlappingWriteScopes(
  tasks: Array<{ allowedPaths: string[] }>,
): boolean {
  return overlappingWriteScopeConflicts(tasks).length > 0;
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
  if (facts.hasOverlappingWriteScopes) {
    throw new Error(
      "Planned worker tasks must have exclusive writable paths; repair shared ownership before routing",
    );
  }
  if (facts.taskCount <= 1) {
    return {
      selectedMode: facts.requestedMode === "orchestrated" ? "one-worker" : "direct",
      reason: "The work is small enough that delegation overhead is not justified",
    };
  }
  return {
    selectedMode: "multi-worker",
    reason: facts.coupling === "high"
      ? "Coupled work is split into dependency-ordered workers with exclusive file ownership"
      : "Independent areas can be isolated and verified with bounded coordination",
  };
}
