import type {
  BudgetPolicy,
  RequestedExecutionMode,
  SelectedExecutionMode,
} from "../contracts.js";

export interface RoutingFacts {
  requestedMode: RequestedExecutionMode;
  taskCount: number;
  changedAreaCount: number;
  maximumParallelWorkers: number;
  coupling: "low" | "medium" | "high";
  estimatedCalls: number;
  estimatedContextTokens: number;
  budget: BudgetPolicy;
}

export interface RouteDecision {
  selectedMode: SelectedExecutionMode;
  reason: string;
}

export interface WriteScopedTask {
  allowedPaths: string[];
}

function normalizedScope(scope: string): string {
  return scope.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function writeScopesOverlap(leftTask: WriteScopedTask, rightTask: WriteScopedTask): boolean {
  for (const leftValue of leftTask.allowedPaths) {
    const left = normalizedScope(leftValue);
    for (const rightValue of rightTask.allowedPaths) {
      const right = normalizedScope(rightValue);
      if (left === right || left.startsWith(right + "/") || right.startsWith(left + "/")) {
        return true;
      }
    }
  }
  return false;
}

/** Reports raw overlap. Raw overlap is safe when the tasks execute in different waves. */
export function tasksHaveOverlappingWriteScopes(
  tasks: WriteScopedTask[],
): boolean {
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      if (writeScopesOverlap(tasks[leftIndex]!, tasks[rightIndex]!)) return true;
    }
  }
  return false;
}

function compatibleWithBatch<T extends WriteScopedTask>(task: T, batch: readonly T[]): boolean {
  return batch.every((selected) => !writeScopesOverlap(task, selected));
}

/**
 * Selects the highest-value conflict-free subset of a dependency-ready wave,
 * then the largest subset on a tie. Plans are capped at twenty tasks, so an
 * exact branch-and-bound search is practical.
 */
export function maximumWriteSafeBatch<T extends WriteScopedTask>(
  ready: readonly T[],
  priority: (task: T) => number = () => 1,
): T[] {
  if (ready.length <= 1) return [...ready];
  let best: T[] = [];
  let bestScore = -1;
  const selected: T[] = [];
  let selectedScore = 0;
  const scores = ready.map((task) => Math.max(1, priority(task)));
  const remainingScores = new Array<number>(ready.length + 1).fill(0);
  for (let index = ready.length - 1; index >= 0; index -= 1) {
    remainingScores[index] = remainingScores[index + 1]! + scores[index]!;
  }

  const search = (index: number): void => {
    if (selectedScore + remainingScores[index]! < bestScore) return;
    if (index >= ready.length) {
      if (selectedScore > bestScore || (selectedScore === bestScore && selected.length > best.length)) {
        best = [...selected];
        bestScore = selectedScore;
      }
      return;
    }
    const task = ready[index]!;
    if (compatibleWithBatch(task, selected)) {
      selected.push(task);
      selectedScore += scores[index]!;
      search(index + 1);
      selectedScore -= scores[index]!;
      selected.pop();
    }
    search(index + 1);
  };

  search(0);
  return best;
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
  if (facts.taskCount <= 1) {
    return {
      selectedMode: facts.requestedMode === "orchestrated" ? "one-worker" : "direct",
      reason: "The work is small enough that delegation overhead is not justified",
    };
  }
  if (facts.maximumParallelWorkers <= 1) {
    return {
      selectedMode: "multi-worker",
      reason: "Specialized workers will run sequentially because dependencies or write scopes prevent safe parallel execution",
    };
  }
  return {
    selectedMode: "multi-worker",
    reason: facts.coupling === "high"
      ? "Coupled work uses dependency-ordered waves with safe parallelism where available"
      : "Independent work uses the largest safe parallel batches while conflicting writes are serialized",
  };
}
