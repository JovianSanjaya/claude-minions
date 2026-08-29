import type { OrchestrationStatus } from "../contracts.js";

export const terminalOrchestrationStatuses = new Set<OrchestrationStatus>([
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

const transitions: Record<OrchestrationStatus, ReadonlySet<OrchestrationStatus>> = {
  "drafting-intent": new Set(["awaiting-confirmation", "budget-exhausted", "cancelled", "failed"]),
  "awaiting-confirmation": new Set(["drafting-intent", "planning", "cancelled"]),
  planning: new Set(["ready", "needs-user", "budget-exhausted", "failed", "cancelled"]),
  ready: new Set(["running", "cancelled"]),
  running: new Set([
    "integrating",
    "needs-user",
    "budget-exhausted",
    "failed",
    "cancelled",
  ]),
  integrating: new Set(["verifying", "needs-user", "failed", "cancelled"]),
  verifying: new Set(["completed", "needs-user", "failed", "cancelled"]),
  "needs-user": new Set(["awaiting-confirmation", "planning", "cancelled"]),
  "budget-exhausted": new Set(),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export class OrchestrationConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "OrchestrationConflictError";
  }
}

export function isTerminalStatus(status: OrchestrationStatus): boolean {
  return terminalOrchestrationStatuses.has(status);
}

export function canTransition(
  from: OrchestrationStatus,
  to: OrchestrationStatus,
): boolean {
  return transitions[from].has(to);
}

export function assertTransition(
  from: OrchestrationStatus,
  to: OrchestrationStatus,
): void {
  if (!canTransition(from, to)) {
    throw new OrchestrationConflictError(
      `Illegal orchestration transition: ${from} -> ${to}`,
    );
  }
}

export function transitionStatus<T extends { status: OrchestrationStatus }>(
  record: T,
  to: OrchestrationStatus,
): void {
  assertTransition(record.status, to);
  record.status = to;
}

export function legalTransitionsFrom(
  status: OrchestrationStatus,
): OrchestrationStatus[] {
  return [...transitions[status]];
}
