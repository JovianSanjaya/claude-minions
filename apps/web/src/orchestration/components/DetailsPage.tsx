import type { OrchestrationReadModel } from "../contracts";
import { DetailList } from "./StatusBadge";

/** Jovian's context/evidence display, expanded into the Details step. */
export function DetailsPage({
  view,
  agentInstructions,
}: {
  view: OrchestrationReadModel;
  agentInstructions: string;
}) {
  const draft = view.activeDraft;
  return (
    <div className="orch-page-stack orch-details-page">
      <section className="orch-panel orch-details-panel" aria-labelledby="orch-details-heading">
        <header>
          <div>
            <span className="eyebrow">Details · Model input</span>
            <h3 id="orch-details-heading">Everything supplied for this run</h3>
            <p className="orch-details-intro">
              The resolved inputs below form the single source of truth for planning and execution.
            </p>
          </div>
        </header>

        <div className="orch-context-grid">
          <article className="orch-context-card" data-kind="request">
            <div className="orch-context-heading">
              <span aria-hidden="true">01</span>
              <div>
                <small>Primary input</small>
                <h4>User request</h4>
              </div>
            </div>
            <p className="orch-context-copy">{view.orchestration.prompt}</p>
          </article>
          <article className="orch-context-card" data-kind="instructions">
            <div className="orch-context-heading">
              <span aria-hidden="true">02</span>
              <div>
                <small>Runtime policy</small>
                <h4>Agent system instructions</h4>
              </div>
            </div>
            <pre>{agentInstructions || "No custom system instructions."}</pre>
          </article>
        </div>

        {draft && (
          <div className="orch-details-grid">
            <article className="orch-detail-section orch-goal-card">
              <span className="orch-detail-kicker">Resolved objective</span>
              <h4>Planner goal</h4>
              <p>{draft.goal}</p>
            </article>
            <article className="orch-detail-section" data-kind="requirement">
              <h4>Requirements</h4>
              <p className="orch-section-description">What the result must include.</p>
              <DetailList items={draft.requirements} kind="requirement" />
            </article>
            <article className="orch-detail-section" data-kind="assumption">
              <h4>Assumptions</h4>
              <p className="orch-section-description">Conditions treated as true for this run.</p>
              <DetailList items={draft.assumptions} kind="assumption" />
            </article>
            <article className="orch-detail-section" data-kind="non-goal">
              <h4>Non-goals</h4>
              <p className="orch-section-description">Explicitly outside the agreed scope.</p>
              <DetailList items={draft.nonGoals} kind="non-goal" />
            </article>
            <article className="orch-detail-section" data-kind="architecture">
              <h4>Architecture decisions</h4>
              <p className="orch-section-description">Technical boundaries the implementation must preserve.</p>
              <DetailList items={draft.architectureDecisions} kind="architecture" />
            </article>
            <article className="orch-detail-section" data-kind="manual">
              <h4>Manual expectations</h4>
              <p className="orch-section-description">Outcomes that require human review.</p>
              <DetailList items={draft.manualExpectations} kind="manual" />
            </article>
          </div>
        )}

      </section>
    </div>
  );
}
