import type { OrchestrationStatus } from "../contracts.js";

export class IllegalTransitionError extends Error {
  /** Lets both Fastify's default handler and the host app's custom one map this to HTTP 409. */
  public readonly statusCode = 409;

  constructor(
    public readonly from: OrchestrationStatus,
    public readonly to: OrchestrationStatus,
  ) {
    super(`Cannot move orchestration from "${from}" to "${to}"`);
    this.name = "IllegalTransitionError";
  }
}

export const TERMINAL_STATUSES: ReadonlySet<OrchestrationStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

/**
 * The canonical state graph from the frozen orchestration specification.
 * Every non-terminal status may additionally move to "cancelled"; that edge
 * is applied programmatically in `isLegalTransition` rather than repeated here.
 */
const LEGAL_TRANSITIONS: Record<OrchestrationStatus, ReadonlySet<OrchestrationStatus>> = {
  "drafting-intent": new Set(["awaiting-confirmation"]),
  "awaiting-confirmation": new Set(["drafting-intent", "planning"]),
  planning: new Set(["ready", "needs-user", "failed"]),
  ready: new Set(["running"]),
  running: new Set(["integrating", "needs-user", "budget-exhausted", "failed"]),
  integrating: new Set(["verifying", "needs-user", "failed"]),
  verifying: new Set(["completed", "needs-user", "failed"]),
  "needs-user": new Set(["awaiting-confirmation", "planning"]),
  "budget-exhausted": new Set([]),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function isLegalTransition(
  from: OrchestrationStatus,
  to: OrchestrationStatus,
): boolean {
  if (from === to) return false;
  if (TERMINAL_STATUSES.has(from)) return false;
  if (to === "cancelled") return true;
  return LEGAL_TRANSITIONS[from].has(to);
}

export function assertLegalTransition(
  from: OrchestrationStatus,
  to: OrchestrationStatus,
): void {
  if (!isLegalTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}
