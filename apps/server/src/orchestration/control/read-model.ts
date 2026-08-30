import type {
  ApplicationMapSummary,
  BudgetPolicy,
  ContextPacketSummary,
  ContractAmendment,
  ExecutionContract,
  IntentDraft,
  Orchestration,
  OrchestrationEvent,
  OrchestrationTask,
  SelectedExecutionMode,
  SharedArtifact,
  UsageLedger,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { redactForResponse } from "./redaction.js";
import type { OrchestrationDatabase, WorkspaceDisposition } from "./store.js";

/**
 * Safe projection of the orchestration database for API responses.
 *
 * Everything returned here has already been redacted before persistence and is
 * redacted again on the way out, with absolute server filesystem paths masked.
 * Protected evaluator source is never stored, so it cannot appear here; only
 * the criterion description and a bounded output summary are exposed.
 */

export interface BudgetStatusView {
  policy: BudgetPolicy;
  modelCalls: number;
  steps: number;
  workerAttempts: number;
  contextExpansions: number;
  openReservations: number;
  wallClockStartedAt: string | null;
  elapsedMs: number | null;
  exhaustedReason: string | null;
}

export interface PlanView {
  selectedMode: SelectedExecutionMode;
  routeReason: string;
  applicationMapVersion: number;
  taskIds: string[];
  createdAt: string;
}

export interface OrchestrationReadModel {
  orchestration: Orchestration;
  intentDraft: IntentDraft | null;
  intentDraftHistory: IntentDraft[];
  activeContract: ExecutionContract | null;
  contractHistory: ExecutionContract[];
  pendingAmendment: ContractAmendment | null;
  amendments: ContractAmendment[];
  plan: PlanView | null;
  applicationMaps: ApplicationMapSummary[];
  tasks: OrchestrationTask[];
  contextPackets: ContextPacketSummary[];
  attempts: WorkerAttempt[];
  artifacts: SharedArtifact[];
  verifications: VerificationRecord[];
  events: OrchestrationEvent[];
  workspaceDispositions: WorkspaceDisposition[];
  usage: UsageLedger;
  budget: BudgetStatusView;
}

const byCreatedAt = (left: { createdAt: string }, right: { createdAt: string }): number =>
  left.createdAt.localeCompare(right.createdAt);

export function findOrchestration(
  database: OrchestrationDatabase,
  orchestrationId: string,
): Orchestration | null {
  return (
    database.orchestrations.find((item) => item.id === orchestrationId) ?? null
  );
}

export function listOrchestrationsForAgent(
  database: OrchestrationDatabase,
  agentId: string,
): Orchestration[] {
  return redactForResponse(
    database.orchestrations
      .filter((item) => item.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  );
}

export function buildBudgetStatus(
  database: OrchestrationDatabase,
  orchestration: Orchestration,
  nowMs: number,
): BudgetStatusView {
  const state = database.budgetStates.find(
    (item) => item.orchestrationId === orchestration.id,
  );
  const sumValues = (record: Record<string, number> | undefined): number =>
    record ? Object.values(record).reduce((total, value) => total + value, 0) : 0;
  const startedAt = state?.wallClockStartedAt ?? null;
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  return {
    policy: orchestration.budget,
    modelCalls: state?.modelCalls ?? 0,
    steps: state?.steps ?? 0,
    workerAttempts: sumValues(state?.workerAttemptsByTask),
    contextExpansions: sumValues(state?.contextExpansionsByTask),
    openReservations:
      state?.reservations.filter((item) => item.status === "open").length ?? 0,
    wallClockStartedAt: startedAt,
    elapsedMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
    exhaustedReason: state?.exhaustedReason ?? null,
  };
}

export interface ReadModelOptions {
  /** Maximum number of events returned, newest kept. */
  eventLimit?: number;
  /** Only return events created strictly after this event id. */
  afterEventId?: string;
  nowMs?: number;
}

export function buildReadModel(
  database: OrchestrationDatabase,
  orchestrationId: string,
  options: ReadModelOptions = {},
): OrchestrationReadModel | null {
  const orchestration = findOrchestration(database, orchestrationId);
  if (!orchestration) {
    return null;
  }
  const nowMs = options.nowMs ?? Date.now();

  const intentDraftHistory = database.intentDrafts
    .filter((item) => item.orchestrationId === orchestrationId)
    .sort((left, right) => left.revision - right.revision);
  const intentDraft =
    intentDraftHistory.find((item) => item.id === orchestration.currentIntentDraftId) ??
    intentDraftHistory[intentDraftHistory.length - 1] ??
    null;

  const contractHistory = database.contracts
    .filter((item) => item.orchestrationId === orchestrationId)
    .sort((left, right) => left.version - right.version);
  const activeContract =
    contractHistory.find((item) => item.id === orchestration.activeContractId) ?? null;

  const amendments = database.amendments
    .filter((item) => item.orchestrationId === orchestrationId)
    .sort(byCreatedAt);
  const pendingAmendment = amendments.find((item) => item.status === "pending") ?? null;

  const planRecord = database.plans.find(
    (item) => item.orchestrationId === orchestrationId,
  );
  const plan: PlanView | null = planRecord
    ? {
        selectedMode: planRecord.selectedMode,
        routeReason: planRecord.routeReason,
        applicationMapVersion: planRecord.applicationMapVersion,
        taskIds: [...planRecord.taskIds],
        createdAt: planRecord.createdAt,
      }
    : null;

  const tasks = database.tasks.filter((item) => item.orchestrationId === orchestrationId);
  const taskIds = new Set(tasks.map((task) => task.id));

  let events = database.events
    .filter((item) => item.orchestrationId === orchestrationId)
    .sort(byCreatedAt);
  if (options.afterEventId) {
    const index = events.findIndex((item) => item.id === options.afterEventId);
    if (index >= 0) {
      events = events.slice(index + 1);
    }
  }
  if (options.eventLimit !== undefined && events.length > options.eventLimit) {
    events = events.slice(events.length - options.eventLimit);
  }

  const model: OrchestrationReadModel = {
    orchestration,
    intentDraft,
    intentDraftHistory,
    activeContract,
    contractHistory,
    pendingAmendment,
    amendments,
    plan,
    applicationMaps: database.applicationMaps
      .filter((item) => item.orchestrationId === orchestrationId)
      .sort((left, right) => left.version - right.version),
    tasks,
    contextPackets: database.contextPackets.filter((item) => taskIds.has(item.taskId)),
    attempts: database.attempts
      .filter((item) => item.orchestrationId === orchestrationId)
      .sort(byCreatedAt),
    artifacts: database.artifacts
      .filter((item) => item.orchestrationId === orchestrationId)
      .sort(byCreatedAt),
    verifications: database.verifications
      .filter((item) => item.orchestrationId === orchestrationId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    events,
    workspaceDispositions: database.workspaceDispositions.filter(
      (item) => item.orchestrationId === orchestrationId,
    ),
    usage: orchestration.usage,
    budget: buildBudgetStatus(database, orchestration, nowMs),
  };

  return redactForResponse(model);
}
