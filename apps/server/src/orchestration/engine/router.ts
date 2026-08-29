import type {
  BudgetPolicy,
  RequestedExecutionMode,
  SelectedExecutionMode,
} from "../contracts.js";

export interface RouteCandidateTask {
  dependsOn: string[];
  allowedPaths: string[];
}

export interface RouteInput {
  requestedMode: RequestedExecutionMode;
  tasks: RouteCandidateTask[];
  criterionCount: number;
  applicationFileCount: number;
  budget: BudgetPolicy;
}

export interface RouteDecision {
  selectedMode: SelectedExecutionMode;
  reason: string;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

function normalizedRoots(paths: string[]): Set<string> {
  return new Set(
    paths.map((value) => value.replaceAll("\\", "/").replace(/^\.\//, "").split("/")[0] ?? ""),
  );
}

function isModular(tasks: RouteCandidateTask[]): boolean {
  if (tasks.length < 2) return false;
  let disjointPairs = 0;
  let pairs = 0;
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      pairs += 1;
      const leftRoots = normalizedRoots(tasks[left]?.allowedPaths ?? []);
      const rightRoots = normalizedRoots(tasks[right]?.allowedPaths ?? []);
      if (![...leftRoots].some((root) => rightRoots.has(root))) disjointPairs += 1;
    }
  }
  const dependencyEdges = tasks.reduce((total, task) => total + task.dependsOn.length, 0);
  return disjointPairs / Math.max(1, pairs) >= 0.5 && dependencyEdges < tasks.length * 2;
}

export function selectExecutionRoute(input: RouteInput): RouteDecision {
  if (input.requestedMode === "direct") {
    return { selectedMode: "direct", reason: "The user explicitly selected direct execution." };
  }

  if (input.budget.maxModelCalls < 2) {
    if (input.requestedMode === "orchestrated") {
      throw new RoutingError("The hard model-call budget cannot fund delegated execution");
    }
    return {
      selectedMode: "direct",
      reason: "The hard model-call budget is too small for delegation overhead.",
    };
  }

  const modular = isModular(input.tasks);
  if (input.requestedMode === "orchestrated") {
    if (modular && input.tasks.length > 1) {
      return {
        selectedMode: "multi-worker",
        reason: "The confirmed work has multiple path-isolated modules and delegation was requested.",
      };
    }
    if (input.tasks.length > 0) {
      return {
        selectedMode: "one-worker",
        reason: "Delegation was requested, but coupling makes one focused worker safer.",
      };
    }
    throw new RoutingError("The confirmed contract is not decomposable into a safe worker task");
  }

  const tiny =
    input.tasks.length <= 1 &&
    input.criterionCount <= 2 &&
    input.applicationFileCount <= 40;
  if (tiny) {
    return {
      selectedMode: "direct",
      reason: "The task is small enough that coordination and duplicated context would dominate.",
    };
  }
  if (modular && input.tasks.length > 1 && input.budget.maxModelCalls >= 4) {
    return {
      selectedMode: "multi-worker",
      reason: "Independent path scopes justify parallel focused workers within the hard budget.",
    };
  }
  return {
    selectedMode: "one-worker",
    reason: "The work benefits from focused context, but its coupling does not justify multiple workers.",
  };
}
