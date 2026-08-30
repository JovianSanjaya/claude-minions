import type { ActorRole, OrchestrationEvent, OrchestrationReadModel, OrchestrationStatus } from "./contracts";

export const terminalStatuses = new Set<OrchestrationStatus>(["budget-exhausted", "completed", "failed", "cancelled"]);
export const isTerminal = (status: OrchestrationStatus) => terminalStatuses.has(status);
export const canConfirmIntent = (view: OrchestrationReadModel | null) => Boolean(view?.orchestration.status === "awaiting-confirmation" && view.activeDraft && view.activeDraft.materialQuestions.length === 0);
export const statusLabel = (status: string) => status.replaceAll("-", " ");
export const formatNumber = (value: number) => new Intl.NumberFormat().format(value);
export const formatEstimatedCost = (value: number | null) => value === null ? "Pricing not configured" : `$${value.toFixed(4)} estimated cost`;
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export interface OrchestrationProgress {
  percent: number;
  stage: string;
  phase: string;
  detail: string;
  activeRole: string | null;
  elapsedMs: number;
  timeoutRemainingMs: number | null;
  lastActivityAt: string;
  heartbeatFresh: boolean;
}

export function orchestrationProgress(
  view: OrchestrationReadModel,
  nowMs: number = Date.now(),
): OrchestrationProgress | null {
  const status = view.orchestration.status;
  if (!["drafting-intent", "planning", "running", "integrating", "verifying"].includes(status)) {
    return null;
  }
  const lastEvent = view.events.at(-1);
  const latestEngineStage = [...view.events].reverse().find((event) =>
    ["integration-step", "verification-step"].includes(event.type),
  );
  const effectiveStatus: OrchestrationStatus = status === "running" && latestEngineStage
    ? latestEngineStage.type === "verification-step" ? "verifying" : "integrating"
    : status;
  const phases: Partial<Record<OrchestrationStatus, [string, string, string]>> = {
    "drafting-intent": ["Stage 1 of 5", "Understanding intent", "The planner is turning the request into a reviewable contract."],
    planning: ["Stage 2 of 5", "Planning execution", "The planner is selecting tasks, ownership, and execution route."],
    running: ["Stage 3 of 5", "Implementing", "Workers are implementing and checking bounded tasks."],
    integrating: ["Stage 4 of 5", "Integrating", "Worker outputs are being assembled into one candidate."],
    verifying: ["Stage 5 of 5", "Verifying", "Trusted checks are running before publication."],
  };
  const [stage, phase, detail] = phases[effectiveStatus]!;
  const activeStart = [...view.events].reverse()
      .filter((event) => event.type === "role-call-started")
      .find((start) => !view.events.some((event) =>
        event.executionId === start.executionId &&
        event.createdAt >= start.createdAt &&
        ["role-call-completed", "role-call-failed"].includes(event.type),
      ));
  const runningAttempt = [...view.attempts].reverse().find((attempt) => attempt.status === "running");
  const stageStartedAt = effectiveStatus === "integrating" || effectiveStatus === "verifying"
    ? latestEngineStage?.createdAt
    : undefined;
  const startedAt = stageStartedAt ?? activeStart?.createdAt ?? runningAttempt?.createdAt ?? lastEvent?.createdAt ?? view.orchestration.updatedAt;
  const timeout = activeStart?.metadata.timeoutMs;
  const timeoutMs = typeof timeout === "number" ? timeout : null;
  const elapsedMs = Math.max(0, nowMs - Date.parse(startedAt));
  let percent: number;
  if (effectiveStatus === "drafting-intent" || effectiveStatus === "planning") {
    percent = timeoutMs === null ? 10 : Math.min(90, Math.max(5, Math.round((elapsedMs / timeoutMs) * 90)));
  } else if (effectiveStatus === "running") {
    const passed = view.tasks.filter((task) => task.status === "passed").length;
    const activeCredit = view.tasks.some((task) => ["preflight", "running"].includes(task.status)) ? 0.5 : 0;
    percent = view.tasks.length ? Math.min(100, Math.round(((passed + activeCredit) / view.tasks.length) * 100)) : 5;
  } else if (effectiveStatus === "integrating") {
    percent = view.events.some((event) => event.type === "integration-candidate") ? 75 : 20;
  } else {
    const completedChecks = view.verifications.filter((record) => record.taskId === null).length;
    percent = Math.min(95, 10 + completedChecks * 40);
  }
  const lastHeartbeat = [...view.events].reverse().find((event) =>
    event.type === "role-call-heartbeat" && (!activeStart || event.executionId === activeStart.executionId),
  );
  const lastActivityAt = lastHeartbeat?.createdAt ?? lastEvent?.createdAt ?? view.orchestration.updatedAt;
  return {
    percent,
    stage,
    phase,
    detail,
    activeRole: activeStart?.actorRole ?? null,
    elapsedMs,
    timeoutRemainingMs: timeoutMs === null ? null : Math.max(0, timeoutMs - elapsedMs),
    lastActivityAt,
    heartbeatFresh: nowMs - Date.parse(lastActivityAt) < 35_000,
  };
}
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
