import type { ActorRole, OrchestrationEvent, OrchestrationTask } from "../contracts";
import { EVENT_FILTERS, eventTone, filterEvents } from "../view-model";
import type { EventFilterKey } from "../view-model";

function formatStamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

const ACTORS: Array<ActorRole | "all"> = [
  "all",
  "planner",
  "worker",
  "verifier",
  "integrator",
  "control-plane",
  "runtime",
  "user",
];

/** Ported from devan/task123 with both task and logical-agent filters. */
export function EvidenceTimeline({
  events,
  tasks,
  filter,
  onFilterChange,
  taskFilter,
  onTaskFilterChange,
  actorFilter,
  onActorFilterChange,
}: {
  events: OrchestrationEvent[];
  tasks: OrchestrationTask[];
  filter: EventFilterKey;
  onFilterChange: (filter: EventFilterKey) => void;
  taskFilter: string | null;
  onTaskFilterChange: (taskId: string | null) => void;
  actorFilter: ActorRole | "all";
  onActorFilterChange: (actor: ActorRole | "all") => void;
}) {
  const visible = filterEvents(events, filter, taskFilter).filter(
    (event) => actorFilter === "all" || event.actorRole === actorFilter,
  );

  return (
    <section className="orch-panel" aria-labelledby="orch-timeline-heading">
      <header>
        <div>
          <span className="eyebrow">Live progress log</span>
          <h3 id="orch-timeline-heading">Model interactions and file changes</h3>
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

      <div className="orch-filter-selects">
        <label htmlFor="orch-agent-filter">
          Agent / role
          <select
            id="orch-agent-filter"
            value={actorFilter}
            onChange={(event) =>
              onActorFilterChange(event.target.value as ActorRole | "all")
            }
          >
            {ACTORS.map((actor) => (
              <option key={actor} value={actor}>
                {actor === "all" ? "All agents" : actor}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="orch-task-filter">
          Assigned task
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
      </div>

      {visible.length === 0 ? (
        <p className="orch-empty">No events match this filter yet.</p>
      ) : (
        <ul className="orch-timeline">
          {[...visible].reverse().map((event) => {
            const tone = eventTone(event);
            // Connection diagnostics include target, DNS, HTTP, timing, and the
            // underlying error identity; keep the complete diagnostic packet visible.
            const metadata = Object.entries(event.metadata).slice(0, 16);
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
                  <strong>{event.type}</strong>
                  <span>{event.summary}</span>
                  <div className="orch-meta">
                    <span>{event.actorRole}</span>
                    {event.modelId && <span>model {event.modelId}</span>}
                    {event.taskId && <span>task {event.taskId}</span>}
                    {event.executionId && <span>execution {event.executionId}</span>}
                    {formatStamp(event.createdAt) && <span>{formatStamp(event.createdAt)}</span>}
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
