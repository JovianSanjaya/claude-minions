import type { ActorRole, OrchestrationEvent, OrchestrationReadModel, OrchestrationStatus } from "./contracts";

export const terminalStatuses = new Set<OrchestrationStatus>(["budget-exhausted", "completed", "failed", "cancelled"]);
export const isTerminal = (status: OrchestrationStatus) => terminalStatuses.has(status);
export const canConfirmIntent = (view: OrchestrationReadModel | null) => Boolean(view?.orchestration.status === "awaiting-confirmation" && view.activeDraft && view.activeDraft.materialQuestions.length === 0);
export const statusLabel = (status: string) => status.replaceAll("-", " ");
export const formatNumber = (value: number) => new Intl.NumberFormat().format(value);
export const formatEstimatedCost = (value: number | null) => value === null ? "Pricing not configured" : `$${value.toFixed(4)} estimated cost`;
export type TimelineFilter = "all" | "failure" | "budget" | "verification" | "integration" | ActorRole;
export function filterEvents(events: OrchestrationEvent[], filter: TimelineFilter, taskId: string): OrchestrationEvent[] {
  return events.filter((event) => {
    if (taskId && event.taskId !== taskId) return false;
    if (filter === "all") return true;
    if (["user", "planner", "worker", "verifier", "integrator", "control-plane", "runtime"].includes(filter)) return event.actorRole === filter;
    const text = `${event.type} ${event.summary}`.toLowerCase();
    return filter === "failure" ? /fail|error|denied/.test(text) : filter === "budget" ? /budget|usage|cost/.test(text) : filter === "verification" ? /verif|check|test/.test(text) : /integrat|publish|conflict/.test(text);
  });
}

export function safeReadModel(value: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...value,
    events: value.events.map(({ id, taskId, executionId, type, actorRole, modelId, summary, metadata, createdAt }) => ({ id, taskId, executionId, type, actorRole, modelId, summary, metadata, createdAt })),
    contextPackets: value.contextPackets.map((packet) => ({ ...packet, sourceFiles: packet.sourceFiles.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) })),
  };
}
