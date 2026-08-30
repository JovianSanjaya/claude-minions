import type { BudgetPolicy, OrchestrationTask, OrchestrationStatus, WorkerAttempt } from "../contracts";
import { computeTaskProgress, describeTaskStatus, taskElapsedLabel } from "../view-model";

export interface RunProgressProps {
  status: OrchestrationStatus;
  tasks: OrchestrationTask[];
  attempts: WorkerAttempt[];
  budget: BudgetPolicy;
  /** Current wall-clock time (ms), supplied by the panel's ticking clock — keeps this component pure/testable. */
  nowMs: number;
}

const PHASE_LABEL: Partial<Record<OrchestrationStatus, string>> = {
  running: "Executing tasks",
  integrating: "Integrating changes",
  verifying: "Running verification",
  "needs-user": "Paused — needs your input",
  "budget-exhausted": "Stopped — budget exhausted",
  completed: "Execution complete",
  failed: "Execution failed",
  cancelled: "Execution cancelled",
};

export function RunProgress({ status, tasks, attempts, budget, nowMs }: RunProgressProps) {
  const progress = computeTaskProgress(tasks);
  const segments: Array<{ key: string; count: number; tone: string; label: string }> = [
    { key: "passed", count: progress.passed, tone: "success", label: "passed" },
    { key: "failed", count: progress.failed, tone: "danger", label: "failed" },
    { key: "cancelled", count: progress.cancelled, tone: "neutral", label: "cancelled" },
    { key: "active", count: progress.active, tone: "info", label: "in progress" },
    { key: "queued", count: progress.queued, tone: "neutral-soft", label: "queued" },
  ].filter((segment) => segment.count > 0);

  return (
    <section className="orch-run-progress" aria-labelledby="orch-run-progress-heading">
      <div className="orch-run-progress-header">
        <h3 id="orch-run-progress-heading">{PHASE_LABEL[status] ?? "Progress"}</h3>
        <span className="orch-muted">
          {progress.passed + progress.failed + progress.cancelled} of {progress.total} tasks done ({progress.percentDone}%)
        </span>
      </div>

      <div
        className="orch-task-progress-track"
        role="progressbar"
        aria-valuenow={progress.percentDone}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Task completion"
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={"orch-task-progress-segment orch-tone-" + segment.tone + (segment.key === "active" ? " orch-pulse" : "")}
            style={{ width: `${(segment.count / progress.total) * 100}%` }}
            title={`${segment.count} ${segment.label}`}
          />
        ))}
      </div>

      <ul className="orch-run-task-list">
        {tasks.map((task) => {
          const taskStatus = describeTaskStatus(task.status);
          const elapsed = taskElapsedLabel(attempts, task.id, nowMs);
          const isActive = task.status === "preflight" || task.status === "running" || task.status === "verifying";
          return (
            <li key={task.id} className="orch-run-task-item">
              <span className={"orch-status-pill orch-tone-" + taskStatus.tone + (isActive ? " orch-pulse" : "")}>{taskStatus.label}</span>
              <span className="orch-run-task-title">{task.title}</span>
              <span className="orch-muted orch-run-task-meta">
                attempt {task.attemptCount}/{budget.maxWorkerAttempts}
                {elapsed ? ` · ${isActive ? "running " : "took "}${elapsed}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
