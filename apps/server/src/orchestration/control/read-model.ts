import { HttpError } from "../../errors.js";
import { redactDeep } from "./redaction.js";
import type { OrchestrationDb } from "./store.js";

export interface OrchestrationReadModel {
  orchestration: OrchestrationDb["orchestrations"][number];
  currentDraft: OrchestrationDb["intentDrafts"][number] | null;
  draftHistory: OrchestrationDb["intentDrafts"];
  activeContract: OrchestrationDb["contracts"][number] | null;
  contractHistory: OrchestrationDb["contracts"];
  amendments: OrchestrationDb["amendments"];
  pendingAmendment: OrchestrationDb["amendments"][number] | null;
  applicationMap: OrchestrationDb["applicationMaps"][number] | null;
  tasks: OrchestrationDb["tasks"];
  artifacts: OrchestrationDb["artifacts"];
  verifications: OrchestrationDb["verifications"];
  attempts: OrchestrationDb["attempts"];
  events: OrchestrationDb["events"];
}

/**
 * Builds the safe, browser-facing view of an orchestration. Never includes
 * protected evaluator source, secrets, or hidden reasoning — `redactDeep` is
 * applied defensively to every collection regardless of whether redaction
 * already happened at write time.
 */
export function buildOrchestrationReadModel(
  db: OrchestrationDb,
  orchestrationId: string,
): OrchestrationReadModel {
  const orchestration = db.orchestrations.find((item) => item.id === orchestrationId);
  if (!orchestration) {
    throw new HttpError(404, "Orchestration not found");
  }
  const draftHistory = db.intentDrafts
    .filter((draft) => draft.orchestrationId === orchestrationId)
    .sort((left, right) => left.revision - right.revision);
  const currentDraft =
    draftHistory.find((draft) => draft.id === orchestration.currentIntentDraftId) ?? null;
  const contractHistory = db.contracts
    .filter((contract) => contract.orchestrationId === orchestrationId)
    .sort((left, right) => left.version - right.version);
  const activeContract =
    contractHistory.find((contract) => contract.id === orchestration.activeContractId) ?? null;
  const amendments = db.amendments
    .filter((amendment) => amendment.orchestrationId === orchestrationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const pendingAmendment = amendments.find((amendment) => amendment.status === "pending") ?? null;
  const applicationMaps = db.applicationMaps
    .filter((map) => map.orchestrationId === orchestrationId)
    .sort((left, right) => right.version - left.version);
  const applicationMap = applicationMaps[0] ?? null;
  const tasks = db.tasks.filter((task) => task.orchestrationId === orchestrationId);
  const artifacts = db.artifacts
    .filter((artifact) => artifact.orchestrationId === orchestrationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const verifications = db.verifications
    .filter((record) => record.orchestrationId === orchestrationId)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const attempts = db.attempts
    .filter((attempt) => attempt.orchestrationId === orchestrationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const events = db.events
    .filter((event) => event.orchestrationId === orchestrationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  return redactDeep({
    orchestration,
    currentDraft,
    draftHistory,
    activeContract,
    contractHistory,
    amendments,
    pendingAmendment,
    applicationMap,
    tasks,
    artifacts,
    verifications,
    attempts,
    events,
  });
}
