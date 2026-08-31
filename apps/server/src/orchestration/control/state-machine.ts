import type { OrchestrationStatus } from "../contracts.js";

export const terminalOrchestrationStatuses = new Set<OrchestrationStatus>([
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

const transitions: Record<OrchestrationStatus, ReadonlySet<OrchestrationStatus>> = {
  "drafting-intent": new Set(["awaiting-confirmation", "connection-paused", "budget-exhausted", "cancelled", "failed"]),
  "awaiting-confirmation": new Set(["drafting-intent", "planning", "connection-paused", "cancelled"]),
  planning: new Set(["ready", "connection-paused", "needs-user", "budget-exhausted", "failed", "cancelled"]),
  ready: new Set(["running", "connection-paused", "cancelled"]),
  running: new Set([
    "integrating",
    "connection-paused",
    "needs-user",
    "budget-exhausted",
    "failed",
    "cancelled",
  ]),
  integrating: new Set(["verifying", "connection-paused", "needs-user", "failed", "cancelled"]),
  verifying: new Set(["completed", "connection-paused", "needs-user", "failed", "cancelled"]),
  "connection-paused": new Set([
    "drafting-intent",
    "planning",
    "awaiting-confirmation",
    "ready",
    "running",
    "integrating",
    "verifying",
    "needs-user",
    "budget-exhausted",
    "failed",
    "cancelled",
  ]),
  "needs-user": new Set(["awaiting-confirmation", "planning", "connection-paused", "cancelled"]),
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
