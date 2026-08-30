import { HttpError } from "../../errors.js";
import type { OrchestrationStatus } from "../contracts.js";

/**
 * Central enforcement point for orchestration lifecycle transitions.
 *
 * Every status change in the control plane goes through
 * {@link assertTransition}. Nothing else may write `orchestration.status`.
 */

export const ORCHESTRATION_STATUSES: readonly OrchestrationStatus[] = [
  "drafting-intent",
  "awaiting-confirmation",
  "planning",
  "ready",
  "running",
  "integrating",
  "verifying",
  "needs-user",
  "budget-exhausted",
  "completed",
  "failed",
  "cancelled",
];

/** Statuses from which no further transition is legal. */
export const TERMINAL_STATUSES: ReadonlySet<OrchestrationStatus> = new Set<OrchestrationStatus>([
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

/**
 * Statuses in which the execution driver may be touching the Agent workspace.
 * Used to keep direct Playground runs and orchestrated work off the same
 * workspace at the same time.
 */
export const WORKSPACE_ACTIVE_STATUSES: ReadonlySet<OrchestrationStatus> =
  new Set<OrchestrationStatus>(["running", "integrating", "verifying"]);

/**
 * Statuses that represent in-flight execution which cannot survive a process
 * restart. Restart reconciliation cancels exactly these.
 */
export const INTERRUPTIBLE_STATUSES: ReadonlySet<OrchestrationStatus> =
  new Set<OrchestrationStatus>([
    "drafting-intent",
    "planning",
    "running",
    "integrating",
    "verifying",
  ]);

/**
 * The legal transition table.
 *
 * The specification's minimum set is implemented verbatim. Two documented
 * supersets are added:
 *  - `failed` is reachable from every active state, because any driver call
 *    may reject;
 *  - `budget-exhausted` is reachable from every active execution state, not
 *    only `running`, because a budget denial can occur during planning,
 *    integration or verification as well.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<OrchestrationStatus, readonly OrchestrationStatus[]>
> = {
  "drafting-intent": ["awaiting-confirmation", "failed", "cancelled"],
  "awaiting-confirmation": ["drafting-intent", "planning", "failed", "cancelled"],
  planning: ["ready", "needs-user", "budget-exhausted", "failed", "cancelled"],
  ready: ["running", "failed", "cancelled"],
  running: ["integrating", "needs-user", "budget-exhausted", "failed", "cancelled"],
  integrating: ["verifying", "needs-user", "budget-exhausted", "failed", "cancelled"],
  verifying: ["completed", "needs-user", "budget-exhausted", "failed", "cancelled"],
  "needs-user": ["awaiting-confirmation", "planning", "failed", "cancelled"],
  "budget-exhausted": [],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: OrchestrationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransition(
  from: OrchestrationStatus,
  to: OrchestrationStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Typed conflict error for an illegal lifecycle transition. */
export class IllegalTransitionError extends HttpError {
  constructor(
    public readonly from: OrchestrationStatus,
    public readonly to: OrchestrationStatus,
  ) {
    super(
      409,
      'Illegal orchestration transition "' + from + '" -> "' + to + '"',
    );
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(
  from: OrchestrationStatus,
  to: OrchestrationStatus,
): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/**
 * Ordered path used when the driver reports a completed execution without
 * having announced the intermediate stages itself.
 */
export function completionPath(
  from: OrchestrationStatus,
): readonly OrchestrationStatus[] {
  switch (from) {
    case "running":
      return ["integrating", "verifying", "completed"];
    case "integrating":
      return ["verifying", "completed"];
    case "verifying":
      return ["completed"];
    default:
      return [];
  }
}
