import type { ExecutionContract, Orchestration, OrchestrationTask } from "../contracts";

const KIND_LABEL: Record<ExecutionContract["criteria"][number]["kind"], string> = {
  functional: "Functional",
  architectural: "Architectural",
  scope: "Scope",
  runtime: "Runtime",
  manual: "Manual",
};

export interface ContractViewProps {
  contract: ExecutionContract;
  orchestration: Orchestration;
  tasks: OrchestrationTask[];
  onStart: () => void;
  busy: boolean;
}

export function ContractView({ contract, orchestration, tasks, onStart, busy }: ContractViewProps) {
  const grouped = new Map<string, typeof contract.criteria>();
  for (const criterion of contract.criteria) {
    const list = grouped.get(criterion.kind) ?? [];
    list.push(criterion);
    grouped.set(criterion.kind, list);
  }

  const isReady = orchestration.status === "ready";

  return (
    <section className="orch-contract-view" aria-labelledby="orch-contract-heading">
      <h3 id="orch-contract-heading">Confirmed contract v{contract.version}</h3>
      <div className="orch-criteria-groups">
        {[...grouped.entries()].map(([kind, criteria]) => (
          <div className="orch-claim-group" key={kind}>
            <h4>{KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind}</h4>
            <ul>
              {criteria.map((criterion) => (
                <li key={criterion.id}>
                  <span>{criterion.description}</span>
                  <span className="orch-provenance-tag"> ({criterion.provenance})</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {orchestration.selectedMode && (
        <div className="orch-route">
          <strong>Route:</strong> {orchestration.selectedMode}
          {tasks.length > 0 && (
            <ul className="orch-task-list">
              {tasks.map((task) => (
                <li key={task.id}>
                  <span className={"orch-task-status orch-task-status-" + task.status}>{task.status}</span>
                  {task.title} — {task.allowedPaths.join(", ") || "(no path restriction)"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {orchestration.status === "planning" && <p className="orch-muted">Planning route and tasks…</p>}

      {isReady && (
        <button type="button" className="button button-primary" disabled={busy} onClick={onStart}>
          Start execution
        </button>
      )}
    </section>
  );
}
