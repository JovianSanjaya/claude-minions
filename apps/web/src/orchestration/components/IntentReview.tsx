import { useState } from "react";
import type { IntentDraft, Orchestration } from "../contracts";
import {
  PROVENANCE_LABEL,
  evaluateConfirmationGate,
  formatElapsedMs,
  formatEstimateRange,
  groupClaimsByProvenance,
} from "../view-model";
import type { OrchestrationReadModel } from "../contracts";
import { ClarificationQuestionCard } from "./ClarificationQuestionCard";

function ClaimList({ title, claims }: { title: string; claims: IntentDraft["requirements"] }) {
  if (claims.length === 0) return null;
  return (
    <div className="orch-claim-group">
      <h4>{title}</h4>
      <ul>
        {claims.map((claim) => (
          <li key={claim.id}>
            <span>{claim.text}</span>
            {claim.rationale && <span className="orch-claim-rationale"> — {claim.rationale}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface IntentReviewProps {
  readModel: OrchestrationReadModel;
  orchestration: Orchestration;
  onAnswer: (questionId: string, answer: { optionId?: string; freeText?: string }) => void;
  onRevise: (note: string) => void;
  onConfirm: () => void;
  busy: boolean;
  /** Current wall-clock time (ms) for the live "still working" elapsed display — a real model round-trip can take well over ten seconds, and with no visible motion this looks indistinguishable from stuck. */
  nowMs: number;
}

export function IntentReview({ readModel, orchestration, onAnswer, onRevise, onConfirm, busy, nowMs }: IntentReviewProps) {
  const [reviseNote, setReviseNote] = useState("");
  const draft = readModel.currentDraft;
  if (!draft) {
    const elapsed = formatElapsedMs(nowMs - new Date(orchestration.createdAt).getTime());
    return (
      <p className="orch-muted orch-elaborating">
        <span className="orch-pulse-dot orch-pulse" aria-hidden="true" />
        Elaborating intent — a real model call, this can take a while ({elapsed} so far)…
      </p>
    );
  }

  const groups = groupClaimsByProvenance(draft);
  const gate = evaluateConfirmationGate(readModel);

  return (
    <section className="orch-intent-review" aria-labelledby="orch-intent-heading">
      <h3 id="orch-intent-heading">Planner's understanding</h3>
      <p className="orch-goal">{draft.goal}</p>

      {draft.openQuestions.length > 0 && (
        <div className="orch-questions">
          <h4>Before we proceed, {draft.openQuestions.length} question{draft.openQuestions.length === 1 ? "" : "s"} matter{draft.openQuestions.length === 1 ? "s" : ""}</h4>
          <ul className="orch-question-list">
            {draft.openQuestions.map((question) => (
              <ClarificationQuestionCard
                key={question.id}
                question={question}
                disabled={busy}
                onAnswer={(answer) => onAnswer(question.id, answer)}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="orch-claims" aria-label="Grounded intent by provenance">
        <ClaimList title={`${PROVENANCE_LABEL["user-explicit"]}`} claims={groups.userExplicit} />
        <ClaimList title={`${PROVENANCE_LABEL["planner-inferred"]}`} claims={groups.plannerInferred} />
        <ClaimList title={`${PROVENANCE_LABEL["repository-derived"]}`} claims={groups.repositoryDerived} />
        <ClaimList title={`${PROVENANCE_LABEL["user-delegated"]}`} claims={groups.userDelegated} />
      </div>

      <p className="orch-estimate">{formatEstimateRange(orchestration)}</p>

      <div className="orch-revise-row">
        <label htmlFor="orch-revise-note">Ask for a change</label>
        <div className="orch-revise-input-row">
          <input
            id="orch-revise-note"
            value={reviseNote}
            onChange={(event) => setReviseNote(event.target.value)}
            placeholder="e.g. Also handle the case where the email is unverified"
            disabled={busy}
          />
          <button
            type="button"
            className="button button-ghost"
            disabled={busy || !reviseNote.trim()}
            onClick={() => {
              onRevise(reviseNote.trim());
              setReviseNote("");
            }}
          >
            Revise
          </button>
        </div>
      </div>

      <div className="orch-confirm-row">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !gate.allowed}
          onClick={onConfirm}
          title={gate.reason ?? undefined}
        >
          Confirm intent
        </button>
        {!gate.allowed && gate.reason && <span className="orch-confirm-reason">{gate.reason}</span>}
      </div>
    </section>
  );
}
