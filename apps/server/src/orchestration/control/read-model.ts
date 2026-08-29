import type {
  ContractAmendment,
  ExecutionContract,
  IntentDraft,
  Orchestration,
  OrchestrationEvent,
  OrchestrationTask,
  SharedArtifact,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { redactClone } from "./redaction.js";
import type {
  CleanupRecord,
  OrchestrationDatabase,
  StoredPlan,
} from "./store.js";

export interface OrchestrationReadModel {
  orchestration: Orchestration;
  activeDraft: IntentDraft | null;
  activeContract: ExecutionContract | null;
  contractHistory: ExecutionContract[];
  intentHistory: IntentDraft[];
  pendingAmendment: ContractAmendment | null;
  amendments: ContractAmendment[];
  plan: StoredPlan | null;
  tasks: OrchestrationTask[];
  usage: Orchestration["usage"];
  events: OrchestrationEvent[];
  artifacts: SharedArtifact[];
  attempts: WorkerAttempt[];
  verifications: VerificationRecord[];
  applicationMaps: OrchestrationDatabase["applicationMaps"];
  contextPackets: OrchestrationDatabase["contextPackets"];
  cleanup: CleanupRecord | null;
}

export class OrchestrationNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(id: string) {
    super(`Orchestration not found: ${id}`);
    this.name = "OrchestrationNotFoundError";
  }
}

export function buildReadModel(
  database: OrchestrationDatabase,
  orchestrationId: string,
): OrchestrationReadModel {
  const orchestration = database.orchestrations.find(
    (entry) => entry.id === orchestrationId,
  );
  if (!orchestration) throw new OrchestrationNotFoundError(orchestrationId);
  const contracts = database.contracts
    .filter((entry) => entry.orchestrationId === orchestrationId)
    .sort((a, b) => a.version - b.version);
  const drafts = database.intentDrafts
    .filter((entry) => entry.orchestrationId === orchestrationId)
    .sort((a, b) => a.revision - b.revision);
  const amendments = database.amendments.filter(
    (entry) => entry.orchestrationId === orchestrationId,
  );
  return redactClone({
    orchestration,
    activeDraft:
      drafts.find((entry) => entry.id === orchestration.currentIntentDraftId) ?? null,
    activeContract:
      contracts.find((entry) => entry.id === orchestration.activeContractId) ?? null,
    contractHistory: contracts,
    intentHistory: drafts,
    pendingAmendment:
      amendments.find((entry) => entry.status === "pending") ?? null,
    amendments,
    plan:
      database.plans.find((entry) => entry.orchestrationId === orchestrationId) ??
      null,
    tasks: database.tasks.filter(
      (entry) => entry.orchestrationId === orchestrationId,
    ),
    usage: orchestration.usage,
    events: database.events.filter(
      (entry) => entry.orchestrationId === orchestrationId,
    ),
    artifacts: database.artifacts.filter(
      (entry) => entry.orchestrationId === orchestrationId,
    ),
    attempts: database.attempts.filter(
      (entry) => entry.orchestrationId === orchestrationId,
    ),
    verifications: database.verifications.filter(
      (entry) => entry.orchestrationId === orchestrationId,
    ),
    applicationMaps: database.applicationMaps.filter(
      (entry) => entry.orchestrationId === orchestrationId,
    ),
    contextPackets: database.contextPackets.filter((packet) =>
      database.tasks.some(
        (task) =>
          task.orchestrationId === orchestrationId && task.id === packet.taskId,
      ),
    ),
    cleanup:
      database.cleanup.find(
        (entry) => entry.orchestrationId === orchestrationId,
      ) ?? null,
  });
}
