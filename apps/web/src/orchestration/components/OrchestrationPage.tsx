import { useMemo, useState } from "react";
import type { ActorRole, OrchestrationReadModel } from "../contracts";
import type { EventFilterKey } from "../view-model";
import { statusLabel } from "../view-model";
import { EvidenceTimeline } from "./EvidenceTimeline";

interface AgentView {
  id: string;
  name: string;
  role: ActorRole;
  taskId: string | null;
  assignment: string;
  instructions: string;
  status: string;
  modelId: string | null;
  changedFiles: string[];
}

export function OrchestrationPage({ view }: { view: OrchestrationReadModel }) {
  const [filter, setFilter] = useState<EventFilterKey>("all");
  const [taskFilter, setTaskFilter] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState<ActorRole | "all">("all");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const agents = useMemo<AgentView[]>(() => {
    const modelFor = (role: ActorRole) =>
      [...view.events].reverse().find((event) => event.actorRole === role && event.modelId)
        ?.modelId ?? null;
    const planner: AgentView = {
      id: "planner",
      name: "Planner",
      role: "planner",
      taskId: null,
      assignment: "Understand the request and produce the task-and-test plan.",
      instructions:
        view.activeDraft?.goal ?? "Ground the request in the application map and confirmed contract.",
      status: view.plan ? "completed" : "running",
      modelId: modelFor("planner"),
      changedFiles: [],
    };
    const workers: AgentView[] = view.tasks.map((task, index) => {
      const attempts = view.attempts.filter((attempt) => attempt.taskId === task.id);
      return {
        id: `worker:${task.id}`,
        name: `Worker ${index + 1}`,
        role: "worker",
        taskId: task.id,
        assignment: task.title,
        instructions: `${task.objective} Allowed paths: ${task.allowedPaths.join(", ") || "planned scope"}.`,
        status: task.status,
        modelId: attempts.at(-1)?.modelId ?? modelFor("worker"),
        changedFiles: [...new Set(attempts.flatMap((attempt) => attempt.changedFiles))],
      };
    });
    const verifier: AgentView = {
      id: "verifier",
      name: "Verifier",
      role: "verifier",
      taskId: null,
      assignment: "Run trusted worker, protected, global, and manual checks.",
      instructions: `${view.verifications.length} verification records are currently attached to this run.`,
      status: view.verifications.some((item) => item.status === "failed")
        ? "failed"
        : view.verifications.length
          ? "passed"
          : "blocked",
      modelId: modelFor("verifier"),
      changedFiles: [],
    };
    const integrator: AgentView = {
      id: "integrator",
      name: "Integrator",
      role: "integrator",
      taskId: null,
      assignment: "Combine verified worker outputs into the publishable candidate.",
      instructions:
        "Use recorded artifacts, changed-file manifests, integration evidence, and global verification.",
      status: view.orchestration.finalOutput
        ? "completed"
        : view.events.some((event) => event.actorRole === "integrator")
          ? "running"
          : "blocked",
      modelId: modelFor("integrator"),
      changedFiles: [...new Set(view.attempts.flatMap((attempt) => attempt.changedFiles))],
    };
    return [planner, ...workers, verifier, integrator];
  }, [view]);

  const selectAgent = (agent: AgentView) => {
    setSelectedAgentId(agent.id);
    setActorFilter(agent.role);
    setTaskFilter(agent.taskId);
    setFilter("all");
  };

  return (
    <div className="orch-page-stack">
      <section className="orch-panel" aria-labelledby="orch-agents-heading">
        <header>
          <div>
            <span className="eyebrow">Orchestration · Live</span>
            <h3 id="orch-agents-heading">Agents, assignments, and instructions</h3>
          </div>
        </header>
        <div className="orch-agent-grid">
          {agents.map((agent) => (
            <button
              type="button"
              className="orch-agent-card"
              data-selected={selectedAgentId === agent.id}
              key={agent.id}
              onClick={() => selectAgent(agent)}
            >
              <div className="orch-card-head">
                <strong>{agent.name}</strong>
                <span className={`orch-state state-${agent.status}`}>
                  {statusLabel(agent.status)}
                </span>
              </div>
              <span className="orch-agent-assignment">{agent.assignment}</span>
              <small>{agent.instructions}</small>
              <div className="orch-meta">
                <span>{agent.modelId ? `model ${agent.modelId}` : "model pending"}</span>
                {agent.taskId && <span>task {agent.taskId}</span>}
              </div>
              {agent.changedFiles.length > 0 && (
                <div className="orch-agent-files">
                  <b>Files changed</b>
                  {agent.changedFiles.map((file) => (
                    <code key={file}>{file}</code>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      </section>

      <EvidenceTimeline
        events={view.events}
        tasks={view.tasks}
        filter={filter}
        onFilterChange={setFilter}
        taskFilter={taskFilter}
        onTaskFilterChange={setTaskFilter}
        actorFilter={actorFilter}
        onActorFilterChange={setActorFilter}
      />
    </div>
  );
}
