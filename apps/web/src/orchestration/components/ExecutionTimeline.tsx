import { useMemo, useState } from "react";
import type { OrchestrationEvent, OrchestrationReadModel } from "../contracts";
import { filterEvents, toSafeEventView } from "../view-model";

export interface ExecutionTimelineProps {
  readModel: OrchestrationReadModel;
}

const FILTER_OPTIONS = ["all", "planner", "worker", "verifier", "integrator", "control-plane", "user"] as const;

export function ExecutionTimeline({ readModel }: ExecutionTimelineProps) {
  const [actorFilter, setActorFilter] = useState<(typeof FILTER_OPTIONS)[number]>("all");

  const events = useMemo(() => {
    const filtered: OrchestrationEvent[] =
      actorFilter === "all" ? readModel.events : filterEvents(readModel.events, { actorRole: actorFilter });
    return filtered.map(toSafeEventView).slice().reverse();
  }, [readModel.events, actorFilter]);

  return (
    <section className="orch-timeline" aria-labelledby="orch-timeline-heading">
      <div className="orch-timeline-header">
        <h3 id="orch-timeline-heading">Timeline</h3>
        <label className="orch-timeline-filter">
          Filter by role
          <select value={actorFilter} onChange={(event) => setActorFilter(event.target.value as (typeof FILTER_OPTIONS)[number])}>
            {FILTER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ol className="orch-timeline-list" aria-live="polite">
        {events.length === 0 && <li className="orch-muted">No events yet.</li>}
        {events.map((event) => (
          <li key={event.id} className={"orch-timeline-item orch-timeline-" + event.type}>
            <span className="orch-timeline-time">{new Date(event.createdAt).toLocaleTimeString()}</span>
            <span className="orch-timeline-actor">{event.actorRole}</span>
            <span className="orch-timeline-summary">{event.summary}</span>
          </li>
        ))}
      </ol>

      {readModel.verifications.length > 0 && (
        <div className="orch-verifications">
          <h4>Verification</h4>
          <ul>
            {readModel.verifications.map((record) => (
              <li key={record.id} className={"orch-verification orch-verification-" + record.status}>
                <span className="orch-badge">{record.scope}</span>
                {record.commandOrCheck}: {record.status}
              </li>
            ))}
          </ul>
        </div>
      )}

      {readModel.artifacts.length > 0 && (
        <div className="orch-artifacts">
          <h4>Shared artifacts</h4>
          <ul>
            {readModel.artifacts.map((artifact) => (
              <li key={artifact.id}>
                {artifact.name} v{artifact.version} ({artifact.kind})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
