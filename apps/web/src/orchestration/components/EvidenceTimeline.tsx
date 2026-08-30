import type { OrchestrationEvent, OrchestrationTask } from "../contracts";
import { EVENT_FILTERS, eventTone, filterEvents } from "../view-model";
import type { EventFilterKey } from "../view-model";

function formatStamp(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

/**
 * Correlated, filterable evidence timeline (specification 8.6).
 *
 * Only persisted safe summaries are rendered. The control plane never sends
 * chain-of-thought or protected evaluator source, and the view model drops
 * forbidden metadata keys before this component ever sees them.
 */
export function EvidenceTimeline({
  events,
  tasks,
  filter,
  onFilterChange,
  taskFilter,
  onTaskFilterChange,
}: {
  events: OrchestrationEvent[];
  tasks: OrchestrationTask[];
  filter: EventFilterKey;
  onFilterChange: (filter: EventFilterKey) => void;
  taskFilter: string | null;
  onTaskFilterChange: (taskId: string | null) => void;
}) {
  const visible = filterEvents(events, filter, taskFilter);

  return (
    <section className="orch-panel" aria-labelledby="orch-timeline-heading">
      <header>
        <div>
          <span className="eyebrow">Evidence</span>
          <h3 id="orch-timeline-heading">Correlated timeline</h3>
        </div>
        <span className="orch-note">
          {visible.length} of {events.length} events
        </span>
      </header>

      <div className="orch-filters" role="group" aria-label="Filter events by category">
        {EVENT_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="orch-filter"
            aria-pressed={item.key === filter}
            onClick={() => onFilterChange(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tasks.length > 0 && (
        <label htmlFor="orch-task-filter">
          Limit to one task
          <select
            id="orch-task-filter"
            value={taskFilter ?? ""}
            onChange={(event) => onTaskFilterChange(event.target.value || null)}
          >
            <option value="">All tasks</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title || task.id}
              </option>
            ))}
          </select>
        </label>
      )}

      {visible.length === 0 ? (
        <p className="orch-empty">No events match this filter yet.</p>
      ) : (
        <ul className="orch-timeline">
          {visible.map((event) => {
            const tone = eventTone(event);
            const metadata = Object.entries(event.metadata).slice(0, 8);
            return (
              <li key={event.id} data-tone={tone}>
                <span className="orch-timeline-mark" aria-hidden="true">
                  {tone === "danger"
                    ? "✕"
                    : tone === "warning"
                      ? "!"
                      : tone === "success"
                        ? "✓"
                        : "•"}
                </span>
                <div className="orch-timeline-body">
                  <strong>
                    {event.type}
                    <span className="orch-visually-hidden"> ({tone})</span>
                  </strong>
                  <span>{event.summary}</span>
                  <div className="orch-meta">
                    <span>{event.actorRole}</span>
                    {event.modelId && <span>model {event.modelId}</span>}
                    {event.taskId && <span>task {event.taskId}</span>}
                    {event.executionId && <span>execution {event.executionId}</span>}
                    {formatStamp(event.createdAt) && (
                      <span>{formatStamp(event.createdAt)}</span>
                    )}
                    {metadata.map(([key, value]) => (
                      <span key={key}>
                        {key}: {String(value)}
                      </span>
                    ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
