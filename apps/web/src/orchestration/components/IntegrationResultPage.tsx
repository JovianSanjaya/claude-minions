import type { OrchestrationReadModel } from "../contracts";
import { statusLabel } from "../view-model";

/** Evidence-backed proposal for step 5; it introduces no new persistence model. */
export function IntegrationResultPage({ view }: { view: OrchestrationReadModel }) {
  const integrationEvents = view.events.filter((event) =>
    /integrat|candidate|publish|conflict|global|verification-step/i.test(event.type),
  );
  const globalChecks = view.verifications.filter(
    (record) => record.taskId === null || record.scope === "global",
  );
  const changedFiles = [...new Set(view.attempts.flatMap((attempt) => attempt.changedFiles))];
  const publishedArtifacts = view.artifacts.filter(
    (artifact) => !artifact.name.startsWith("Planner acceptance test:"),
  );

  return (
    <div className="orch-page-stack">
      <section className="orch-panel orch-result-hero">
        <span className="eyebrow">Integration (Result)</span>
        <div className="orch-title-row">
          <h3>
            {view.orchestration.status === "completed"
              ? "Verified candidate"
              : "Integration evidence and publish readiness"}
          </h3>
          <span className={`orch-state state-${view.orchestration.status}`}>
            {statusLabel(view.orchestration.status)}
          </span>
        </div>
        <p>
          {view.orchestration.finalOutput ??
            view.orchestration.error ??
            "The final result will appear when integration and trusted verification finish."}
        </p>
      </section>

      <div className="orch-result-grid">
        <section className="orch-panel">
          <h3>Candidate manifest</h3>
          {changedFiles.length ? (
            <ul className="orch-file-list">
              {changedFiles.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="orch-empty">No changed-file manifest is recorded yet.</p>
          )}
        </section>

        <section className="orch-panel">
          <h3>Published artifacts</h3>
          {publishedArtifacts.length ? (
            <ul className="orch-plain-list">
              {publishedArtifacts.map((artifact) => (
                <li key={`${artifact.id}:${artifact.version}`}>
                  <strong>{artifact.name}</strong>
                  <span>
                    {artifact.kind} · v{artifact.version} · task {artifact.producerTaskId}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="orch-empty">No publishable artifact is recorded yet.</p>
          )}
        </section>
      </div>

      <section className="orch-panel">
        <h3>Integration and publication evidence</h3>
        {integrationEvents.length ? (
          <ol className="orch-evidence-list">
            {integrationEvents.map((event) => (
              <li key={event.id}>
                <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                <div>
                  <strong>{statusLabel(event.type)}</strong>
                  <p>{event.summary}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="orch-empty">Integration has not emitted evidence yet.</p>
        )}
      </section>

      <section className="orch-panel">
        <h3>Trusted release checks</h3>
        {globalChecks.length ? (
          <ul className="orch-test-list">
            {globalChecks.map((record) => (
              <li key={record.id} data-status={record.status}>
                <span>{record.commandOrCheck}</span>
                <small>
                  {record.status} · {record.outputSummary}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="orch-empty">Global verification has not run yet.</p>
        )}
        {view.cleanup && (
          <p className="orch-note">
            Temporary workspace: {view.cleanup.status} — {view.cleanup.summary}
          </p>
        )}
      </section>
    </div>
  );
}
