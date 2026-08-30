import { useEffect, useMemo, useState } from "react";
import type { OrchestrationApi } from "./api-port";
import type { OrchestrationReadModel, RequestedMode } from "./contracts";
import { EvidenceGrid } from "./components/EvidenceGrid";
import { pollOrchestration } from "./polling";
import { canConfirmIntent, filterEvents, formatEstimatedCost, formatNumber, statusLabel, type TimelineFilter } from "./view-model";
import "./orchestration.css";

interface Props { agentId: string; agentStatus: "ready" | "busy" | "stopped" | "error"; api: OrchestrationApi; onDirectSend(prompt: string): Promise<void>; onTerminal?(): void }
const modes: Array<{ id: RequestedMode; label: string; help: string }> = [
  { id: "direct", label: "Direct", help: "Use the existing single-Agent conversation." },
  { id: "auto", label: "Auto", help: "Let the router choose direct, one worker, or multiple workers." },
  { id: "orchestrated", label: "Orchestrated", help: "Plan and coordinate isolated workers with verification." },
];

export function OrchestrationPanel({ agentId, agentStatus, api, onDirectSend, onTerminal }: Props) {
  const [mode, setMode] = useState<RequestedMode>("auto");
  const [prompt, setPrompt] = useState("");
  const [view, setView] = useState<OrchestrationReadModel | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [taskFilter, setTaskFilter] = useState("");

  useEffect(() => { setView(null); setActiveId(null); setError(null); void api.list(agentId).then(({ orchestrations }) => { const current = orchestrations.find((item) => !["completed", "failed", "cancelled", "budget-exhausted"].includes(item.status)) ?? orchestrations[0]; if (current) setActiveId(current.id); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [agentId, api]);
  useEffect(() => { if (!activeId) return; const handle = pollOrchestration(api, activeId, (next) => { setView(next); if (["completed", "failed", "cancelled", "budget-exhausted"].includes(next.orchestration.status)) onTerminal?.(); }, (reason) => setError(`Refresh delayed: ${reason.message}`)); return () => handle.stop(); }, [activeId, api, onTerminal]);
  const events = useMemo(() => view ? filterEvents(view.events, filter, taskFilter) : [], [view, filter, taskFilter]);
  const action = async (work: () => Promise<unknown>) => { setPending(true); setError(null); try { await work(); if (activeId) setView(await api.get(activeId)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setPending(false); } };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const content = prompt.trim(); if (!content) return; setPending(true); setError(null); try { if (mode === "direct") { await onDirectSend(content); setPrompt(""); } else { const result = await api.create(agentId, { prompt: content, requestedMode: mode }); setActiveId(result.orchestration.id); setPrompt(""); } } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setPending(false); } };
  const orchestration = view?.orchestration;
  return <section className="orchestration-panel" aria-labelledby="orchestration-title">
    <header className="orch-header"><div><span className="eyebrow">Execution control</span><h2 id="orchestration-title">Direct or coordinated build</h2></div>{orchestration && <span className={`orch-state state-${orchestration.status}`} aria-live="polite">{statusLabel(orchestration.status)}</span>}</header>
    <form className="orch-composer" onSubmit={submit}>
      <fieldset className="orch-modes"><legend>Execution mode</legend>{modes.map((item) => <label key={item.id} className={mode === item.id ? "selected" : ""}><input type="radio" name="mode" value={item.id} checked={mode === item.id} onChange={() => setMode(item.id)} /><span><b>{item.label}</b><small>{item.help}</small></span></label>)}</fieldset>
      <label className="orch-prompt">Task<textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the outcome and constraints…" disabled={pending || agentStatus === "stopped"} /></label>
      <button className="button button-primary" disabled={pending || !prompt.trim() || agentStatus === "stopped"}>{pending ? "Working…" : mode === "direct" ? "Send direct" : "Review intent"}</button>
    </form>
    {error && <div className="orch-error" role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
    {view && <div className="orch-body">
      {view.activeDraft && <section className="orch-intent orch-card"><div className="orch-title-row"><div><span className="eyebrow">Intent revision {view.activeDraft.revision}</span><h3>{view.activeDraft.goal}</h3></div>{view.activeContract && <small>Contract v{view.activeContract.version} · {new Date(view.activeContract.confirmedAt).toLocaleString()}</small>}</div><div className="orch-intent-grid"><IntentList title="Requirements" values={view.activeDraft.requirements}/><IntentList title="Assumptions" values={view.activeDraft.assumptions}/><IntentList title="Non-goals" values={view.activeDraft.nonGoals}/><IntentList title="Architecture decisions" values={view.activeDraft.architectureDecisions}/><IntentList title="Manual expectations" values={view.activeDraft.manualExpectations}/><IntentList title="Material questions" values={view.activeDraft.materialQuestions} warning/></div>{orchestration?.estimate && <div className="orch-estimate"><span><b>{formatNumber(orchestration.estimate.inputTokenLow)}–{formatNumber(orchestration.estimate.inputTokenHigh)}</b> estimated input</span><span><b>{formatNumber(orchestration.estimate.outputTokenLow)}–{formatNumber(orchestration.estimate.outputTokenHigh)}</b> estimated output</span><span>{orchestration.estimate.estimatedUsdHigh === null ? "Pricing not configured" : formatEstimatedCost(orchestration.estimate.estimatedUsdHigh)}</span></div>}{orchestration?.status === "awaiting-confirmation" && <div className="orch-actions"><label>Revision or answers<textarea rows={2} value={revision} onChange={(event) => setRevision(event.target.value)} /></label><button className="button button-ghost" disabled={pending || !revision.trim()} onClick={() => void action(async () => { await api.reviseIntent(orchestration.id, revision); setRevision(""); })}>Revise</button><button className="button button-primary" disabled={pending || !canConfirmIntent(view)} title={view.activeDraft.materialQuestions.length ? "Answer material questions before confirming" : "Confirm this contract"} onClick={() => void action(() => api.confirm(orchestration.id))}>Confirm contract</button></div>}</section>}
      {view.pendingAmendment && <section className="orch-card orch-amendment"><h3>Material amendment needs you</h3><p>{view.pendingAmendment.reason}</p><button className="button button-primary" onClick={() => void action(() => api.confirmAmendment(view.orchestration.id, view.pendingAmendment!.id))}>Confirm amendment</button><button className="button button-ghost" onClick={() => void action(() => api.rejectAmendment(view.orchestration.id, view.pendingAmendment!.id))}>Reject</button></section>}
      {orchestration?.status === "ready" && <section className="orch-start orch-card"><div><h3>Plan ready</h3><p>{view.plan?.routeReason}</p></div><button className="button button-primary" disabled={pending} onClick={() => void action(() => api.start(orchestration.id))}>Start execution</button></section>}
      {orchestration && !["completed", "failed", "cancelled", "budget-exhausted"].includes(orchestration.status) && <div className="orch-control-row"><button className="button button-danger" disabled={pending} onClick={() => void action(() => api.cancel(orchestration.id))}>Cancel orchestration</button></div>}
      <EvidenceGrid view={view}/>
      <section className="orch-card orch-wide"><div className="orch-title-row"><h3>Correlated timeline</h3><div className="orch-filters"><label>Event filter<select value={filter} onChange={(event) => setFilter(event.target.value as TimelineFilter)}><option value="all">All</option><option value="worker">Worker</option><option value="planner">Planner</option><option value="failure">Failures</option><option value="budget">Budget</option><option value="verification">Verification</option><option value="integration">Integration</option></select></label><label>Task<select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}><option value="">All tasks</option>{view.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div></div><ol className="orch-timeline">{events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><div><strong>{event.actorRole} · {statusLabel(event.type)}</strong><p>{event.summary}</p>{event.modelId && <small>Model {event.modelId}</small>}</div></li>)}</ol></section>
      {(orchestration?.finalOutput || orchestration?.error) && <section className={`orch-card orch-result ${orchestration.status === "completed" ? "success" : "failure"}`}><h3>{orchestration.status === "completed" ? "Verified result" : statusLabel(orchestration.status)}</h3><p>{orchestration.finalOutput ?? orchestration.error}</p>{orchestration.status === "budget-exhausted" && <strong>Exact budget stop: {orchestration.error}</strong>}{view.cleanup && <small>Cleanup: {view.cleanup.status} — {view.cleanup.summary}</small>}</section>}
    </div>}
  </section>;
}

function IntentList({ title, values, warning = false }: { title: string; values: string[]; warning?: boolean }) { return <div className={warning && values.length ? "warning" : ""}><h4>{title}</h4>{values.length ? <ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul> : <p>None</p>}</div>; }
