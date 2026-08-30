import { useState } from "react";
import type {
  ContractAmendment,
  CostEstimate,
  ExecutionContract,
  IntentDraft,
} from "../contracts";
import type { ConfirmationGate } from "../view-model";
import { PRICING_NOT_CONFIGURED, formatTokens } from "../view-model";
import { BulletList, Fact } from "./StatusBadge";

function estimateTokenRange(estimate: CostEstimate): string {
  const low = estimate.inputTokenLow + estimate.outputTokenLow;
  const high = estimate.inputTokenHigh + estimate.outputTokenHigh;
  return formatTokens(low) + " – " + formatTokens(high) + " tokens";
}

function estimateCostRange(estimate: CostEstimate): string {
  if (
    estimate.pricingStatus !== "configured" ||
    estimate.estimatedUsdLow === null ||
    estimate.estimatedUsdHigh === null
  ) {
    return PRICING_NOT_CONFIGURED;
  }
  return (
    "estimated cost $" +
    estimate.estimatedUsdLow.toFixed(4) +
    " – $" +
    estimate.estimatedUsdHigh.toFixed(4)
  );
}

/**
 * Intent review and explicit confirmation (specification 8.5).
 *
 * Confirm is disabled while material questions are unanswered, and confirming
 * always names the exact draft revision the user read, so a stale screen can
 * never confirm a newer interpretation.
 */
export function IntentReview({
  draft,
  estimate,
  budgetSummary,
  gate,
  answers,
  onAnswerChange,
  onRevise,
  onConfirm,
  busy,
}: {
  draft: IntentDraft;
  estimate: CostEstimate | null;
  budgetSummary: string;
  gate: ConfirmationGate;
  answers: Record<string, string>;
  onAnswerChange: (question: string, answer: string) => void;
  onRevise: (revisionRequest: string) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const [revision, setRevision] = useState("");

  return (
    <section className="orch-panel" aria-labelledby="orch-intent-heading">
      <header>
        <div>
          <span className="eyebrow">Planner interpretation · revision {draft.revision}</span>
          <h3 id="orch-intent-heading">Confirm what will be built</h3>
        </div>
      </header>

      <p>{draft.goal || "The planner did not record a goal."}</p>

      <h4>Requirements</h4>
      <BulletList items={draft.requirements} empty="No requirements recorded." />

      <h4>Assumptions</h4>
      <BulletList items={draft.assumptions} empty="No assumptions recorded." />

      <h4>Non-goals</h4>
      <BulletList items={draft.nonGoals} empty="No non-goals recorded." />

      <h4>Material architecture decisions</h4>
      <BulletList
        items={draft.architectureDecisions}
        empty="No architecture decisions recorded."
      />

      <h4>Manual expectations</h4>
      <BulletList
        items={draft.manualExpectations}
        empty="Nothing that needs a human judgement was recorded."
      />

      {estimate && (
        <>
          <h4>Estimate and hard budget</h4>
          <dl className="orch-facts">
            <Fact term="Token range">{estimateTokenRange(estimate)}</Fact>
            <Fact term="Cost range">{estimateCostRange(estimate)}</Fact>
            <Fact term="Hard budget">{budgetSummary}</Fact>
          </dl>
          {estimate.assumptions.length > 0 && (
            <>
              <h4>Estimate assumptions</h4>
              <BulletList items={estimate.assumptions} />
            </>
          )}
        </>
      )}

      {draft.materialQuestions.length > 0 && (
        <>
          <h4>Unresolved material questions</h4>
          <div className="orch-plain-list">
            {draft.materialQuestions.map((question, index) => {
              const inputId = "orch-question-" + index;
              return (
                <div className="orch-question" key={question}>
                  <p id={inputId + "-label"}>{question}</p>
                  <label className="orch-visually-hidden" htmlFor={inputId}>
                    Answer for: {question}
                  </label>
                  <input
                    id={inputId}
                    value={answers[question] ?? ""}
                    onChange={(event) => onAnswerChange(question, event.target.value)}
                    placeholder="Your answer"
                    disabled={busy}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}

      <h4>Revise the interpretation</h4>
      <form
        className="orch-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (revision.trim()) {
            onRevise(revision.trim());
            setRevision("");
          }
        }}
      >
        <label htmlFor="orch-revision">
          What did the planner get wrong?
          <textarea
            id="orch-revision"
            rows={2}
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            disabled={busy}
          />
        </label>
        <div className="orch-actions orch-actions--end">
          <button
            type="submit"
            className="button button-ghost"
            disabled={busy || !revision.trim()}
          >
            Revise
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={onConfirm}
            disabled={busy || !gate.canConfirm}
            aria-describedby={gate.reason ? "orch-confirm-reason" : undefined}
          >
            Confirm contract
          </button>
        </div>
        {gate.reason && (
          <p className="orch-note" id="orch-confirm-reason" role="status">
            {gate.reason}
          </p>
        )}
      </form>
    </section>
  );
}

/** Contract identity after confirmation. */
export function ContractSummary({ contract }: { contract: ExecutionContract }) {
  return (
    <section className="orch-panel" aria-labelledby="orch-contract-heading">
      <header>
        <div>
          <span className="eyebrow">Confirmed contract</span>
          <h3 id="orch-contract-heading">Version {contract.version}</h3>
        </div>
      </header>
      <dl className="orch-facts">
        <Fact term="Confirmed at">{contract.confirmedAt || "unknown"}</Fact>
        <Fact term="Confirmed by">{contract.confirmedBy}</Fact>
        <Fact term="Supersedes">
          {contract.supersedesContractId
            ? "version " + (contract.version - 1)
            : "nothing — first version"}
        </Fact>
      </dl>
      <h4>Acceptance criteria</h4>
      {contract.criteria.length === 0 ? (
        <p className="orch-note">No criteria recorded.</p>
      ) : (
        <ul className="orch-plain-list">
          {contract.criteria.map((criterion) => (
            <li className="orch-card" key={criterion.id}>
              <div className="orch-card-head">
                <strong>{criterion.description}</strong>
                <span className="orch-code">{criterion.kind}</span>
              </div>
              <div className="orch-meta">
                <span>id {criterion.id}</span>
                <span>verified by {criterion.verification}</span>
                {criterion.verification === "protected-test" && (
                  <span>implementation is not visible to workers or to this screen</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Material amendments must be explicitly confirmed or rejected. Difficulty
 * never silently weakens a confirmed contract.
 */
export function AmendmentReview({
  amendment,
  onConfirm,
  onReject,
  busy,
}: {
  amendment: ContractAmendment;
  onConfirm: () => void;
  onReject: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <section className="orch-panel" aria-labelledby="orch-amendment-heading">
      <header>
        <div>
          <span className="eyebrow">
            {amendment.material ? "Material amendment" : "Amendment"} · needs your decision
          </span>
          <h3 id="orch-amendment-heading">The confirmed contract cannot be met as written</h3>
        </div>
      </header>
      <p>{amendment.reason}</p>

      <h4>Proposed change</h4>
      <BulletList
        items={[
          "Goal: " + amendment.proposedIntent.goal,
          ...amendment.proposedIntent.requirements.map((item) => "Requirement: " + item),
          ...(amendment.proposedCriteria ?? []).map(
            (item) => "Criterion " + item.id + ": " + item.description,
          ),
        ].filter((item) => item.trim().length > 6)}
        empty="No structural change was proposed."
      />

      <form
        className="orch-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          onReject(reason.trim());
          setReason("");
        }}
      >
        <label htmlFor="orch-amendment-reason">
          Reason for rejecting (optional)
          <input
            id="orch-amendment-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
          />
        </label>
        <div className="orch-actions orch-actions--end">
          <button type="submit" className="button button-danger" disabled={busy}>
            Reject amendment
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={onConfirm}
            disabled={busy}
          >
            Confirm amendment
          </button>
        </div>
      </form>
    </section>
  );
}
