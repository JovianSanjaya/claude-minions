import type { OrchestrationReadModel } from "../contracts";
import { formatTokens, taskStatusPresentation } from "../view-model";
import { StatusBadge } from "./StatusBadge";

interface PlannedAcceptanceTest {
  id: string;
  title: string;
  criterionIds: string[];
  category: string;
  scope: string;
  procedure: string;
  expectedOutcome: string;
}

function plannedTests(view: OrchestrationReadModel): PlannedAcceptanceTest[] {
  const isTest = (item: unknown): item is PlannedAcceptanceTest => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<PlannedAcceptanceTest>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.title === "string" &&
      Array.isArray(candidate.criterionIds) &&
      typeof candidate.procedure === "string" &&
      typeof candidate.expectedOutcome === "string"
    );
  };
  return view.artifacts.flatMap((artifact) => {
    if (
      !(artifact.name.startsWith("Contract acceptance test:") || artifact.name.startsWith("Planner acceptance test:")) ||
      !artifact.payload
    ) {
      return [];
    }
    try {
      const value = JSON.parse(artifact.payload) as unknown;
      return isTest(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Ported from devan/task123's PlanBoard and focused on the task-and-test page. */
export function PlanBoard({ view }: { view: OrchestrationReadModel }) {
  const packetsByTask = new Map(view.contextPackets.map((packet) => [packet.taskId, packet]));
  const criteriaById = new Map(
    (view.activeContract?.criteria ?? []).map((criterion) => [criterion.id, criterion]),
  );
  const acceptanceTests = plannedTests(view);
  const unassignedTests = acceptanceTests.filter((test) => test.criterionIds.length === 0);

  return (
    <section className="orch-panel" aria-labelledby="orch-plan-heading">
      <header>
        <div>
          <span className="eyebrow">Task graph & contract checks</span>
          <h3 id="orch-plan-heading">
            {view.plan ? routeLabel(view.plan.selectedMode) : "Planning the execution route"}
          </h3>
        </div>
      </header>

      <p>{view.plan?.routeReason ?? "The planner has not committed a route yet."}</p>

      <dl className="orch-facts">
        <div className="orch-fact">
          <dt>Tasks</dt>
          <dd>{view.tasks.length}</dd>
        </div>
        <div className="orch-fact">
          <dt>Application map</dt>
          <dd>
            v{view.plan?.applicationMapVersion ?? "—"} ·{" "}
            {view.applicationMaps.at(-1)?.fileCount ?? 0} files
          </dd>
        </div>
        <div className="orch-fact">
          <dt>Contract</dt>
          <dd>v{view.activeContract?.version ?? "—"}</dd>
        </div>
      </dl>

      {view.tasks.length === 0 ? (
        <p className="orch-empty">No tasks have been planned yet.</p>
      ) : (
        <ol className="orch-plan-list">
          {view.tasks.map((task, taskIndex) => {
            const packet = packetsByTask.get(task.id);
            const criteria = task.acceptanceCriterionIds.flatMap((id) => {
              const criterion = criteriaById.get(id);
              return criterion ? [criterion] : [];
            });
            const verifications = view.verifications.filter(
              (record) => record.taskId === task.id,
            );
            const tests = acceptanceTests.filter((test) =>
              test.criterionIds.some((criterionId) =>
                task.acceptanceCriterionIds.includes(criterionId),
              ),
            );
            return (
              <li className="orch-card" key={task.id}>
                <div className="orch-card-head">
                  <div>
                    <span className="orch-step-number">{taskIndex + 1}</span>
                    <strong>{task.title || task.id}</strong>
                  </div>
                  <StatusBadge presentation={taskStatusPresentation(task.status)} />
                </div>
                <p>{task.objective}</p>
                <div className="orch-meta">
                  <span>attempt {task.attemptCount}</span>
                  <span>map v{task.applicationMapVersion}</span>
                  {task.dependsOn.length > 0 && (
                    <span>depends on {task.dependsOn.join(", ")}</span>
                  )}
                  {packet && (
                    <span>
                      context {packet.sourceFiles.length} files · ~
                      {formatTokens(packet.estimatedTokens)} tokens
                    </span>
                  )}
                </div>

                <h4>Instructions</h4>
                <p className="orch-note">
                  Work only within {task.allowedPaths.join(", ") || "the planned scope"}.
                  {task.requiredArtifactIds.length
                    ? ` Consume required artifacts: ${task.requiredArtifactIds.join(", ")}.`
                    : ""}
                </p>

                <h4>Tests and acceptance checks</h4>
                {criteria.length === 0 && tests.length === 0 && verifications.length === 0 ? (
                  <p className="orch-note">No task-specific tests have been recorded yet.</p>
                ) : (
                  <ul className="orch-test-list">
                    {tests.map((test) => (
                      <li key={test.id}>
                        <span>
                          <strong>{test.title}</strong>
                          <small>{test.procedure}</small>
                        </span>
                        <small>
                          {test.scope} · {test.category}
                          <br />
                          Pass: {test.expectedOutcome}
                        </small>
                      </li>
                    ))}
                    {criteria.map((criterion) => (
                      <li key={criterion.id}>
                        <span>{criterion.description}</span>
                        <small>
                          {criterion.kind} · {criterion.verification}
                        </small>
                      </li>
                    ))}
                    {verifications.map((record) => (
                      <li key={record.id} data-status={record.status}>
                        <span>{record.commandOrCheck}</span>
                        <small>
                          {record.status} · {record.outputSummary}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {unassignedTests.length > 0 && (
        <>
          <h4>Global and regression test list</h4>
          <ul className="orch-test-list">
            {unassignedTests.map((test) => (
              <li key={test.id}>
                <span>
                  <strong>{test.title}</strong>
                  <small>{test.procedure}</small>
                </span>
                <small>
                  {test.scope} · {test.category}
                  <br />
                  Pass: {test.expectedOutcome}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function routeLabel(mode: "direct" | "one-worker" | "multi-worker"): string {
  if (mode === "direct") return "Direct execution selected";
  if (mode === "one-worker") return "One focused worker selected";
  return "Multiple workers selected";
}
