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
}

/**
 * Builds the safe, browser-facing view of an orchestration: current state,
 * intent draft history, confirmed contract history, and amendments. Never
 * includes protected evaluator source, secrets, or hidden reasoning — those
 * simply do not exist in this restricted build's persisted collections, and
 * `redactDeep` is applied defensively regardless.
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

  return redactDeep({
    orchestration,
    currentDraft,
    draftHistory,
    activeContract,
    contractHistory,
    amendments,
    pendingAmendment,
  });
}
