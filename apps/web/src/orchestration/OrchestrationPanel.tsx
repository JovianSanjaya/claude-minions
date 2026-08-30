import { useEffect, useMemo, useState } from "react";
import type { OrchestrationApi } from "./api-port";
import type { ModelStrategy, OrchestrationReadModel, RequestedMode, WorkerRoutingPreference } from "./contracts";
import { EvidenceGrid } from "./components/EvidenceGrid";
import { pollOrchestration } from "./polling";
import { canConfirmIntent, filterEvents, formatDuration, formatEstimatedCost, formatNumber, orchestrationProgress, statusLabel, type TimelineFilter } from "./view-model";
import "./orchestration.css";

interface Props { agentId: string; agentStatus: "ready" | "busy" | "stopped" | "error"; api: OrchestrationApi; onDirectSend(prompt: string): Promise<void>; bigModelId?: string | null; smallModelId?: string | null; onTerminal?(): void }
const modes: Array<{ id: RequestedMode; label: string; help: string }> = [
  { id: "direct", label: "Direct", help: "Use the existing single-Agent conversation." },
  { id: "auto", label: "Auto", help: "Let the router choose direct, one worker, or multiple workers." },
  { id: "orchestrated", label: "Orchestrated", help: "Plan and coordinate isolated workers with verification." },
];

interface AgentExecutionPreferences {
  mode: RequestedMode;
  modelStrategy: ModelStrategy;
  workerRouting: WorkerRoutingPreference;
}

const defaultPreferences: AgentExecutionPreferences = {
  mode: "auto",
  modelStrategy: "mixed",
  workerRouting: "adaptive",
};

function preferencesKey(agentId: string): string {
  return `agent-launchpad:execution-preferences:${agentId}`;
}

function loadPreferences(agentId: string): AgentExecutionPreferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(preferencesKey(agentId)) ?? "null") as Partial<AgentExecutionPreferences> | null;
    return {
      mode: stored?.mode && ["direct", "auto", "orchestrated"].includes(stored.mode) ? stored.mode : defaultPreferences.mode,
      modelStrategy: stored?.modelStrategy && ["mixed", "big-only", "small-only"].includes(stored.modelStrategy) ? stored.modelStrategy : defaultPreferences.modelStrategy,
      workerRouting: stored?.workerRouting && ["adaptive", "one-worker", "multi-worker"].includes(stored.workerRouting) ? stored.workerRouting : defaultPreferences.workerRouting,
    };
  } catch {
    return defaultPreferences;
  }
}

function savePreferences(agentId: string, preferences: AgentExecutionPreferences): void {
  try {
    window.localStorage.setItem(preferencesKey(agentId), JSON.stringify(preferences));
  } catch {
    // Keep the controls usable when browser storage is unavailable.
  }
}

export function OrchestrationPanel({ agentId, agentStatus, api, onDirectSend, bigModelId, smallModelId, onTerminal }: Props) {
  const preferences = useMemo(() => loadPreferences(agentId), [agentId]);
  const [mode, setMode] = useState<RequestedMode>(preferences.mode);
  const [modelStrategy, setModelStrategy] = useState<ModelStrategy>(preferences.modelStrategy);
  const [workerRouting, setWorkerRouting] = useState<WorkerRoutingPreference>(preferences.workerRouting);
  const [prompt, setPrompt] = useState("");
  const [view, setView] = useState<OrchestrationReadModel | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [taskFilter, setTaskFilter] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => { setView(null); setActiveId(null); setError(null); void api.list(agentId).then(({ orchestrations }) => { const current = orchestrations.find((item) => !["completed", "failed", "cancelled", "budget-exhausted"].includes(item.status)) ?? orchestrations[0]; if (current) setActiveId(current.id); }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))); }, [agentId, api]);
  useEffect(() => {
    savePreferences(agentId, { mode, modelStrategy, workerRouting });
  }, [agentId, mode, modelStrategy, workerRouting]);
  useEffect(() => { if (!activeId) return; const handle = pollOrchestration(api, activeId, (next) => { setView(next); if (["completed", "failed", "cancelled", "budget-exhausted"].includes(next.orchestration.status)) onTerminal?.(); }, (reason) => setError(`Refresh delayed: ${reason.message}`)); return () => handle.stop(); }, [activeId, api, onTerminal]);
  useEffect(() => { const timer = window.setInterval(() => setNowMs(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const events = useMemo(() => view ? filterEvents(view.events, filter, taskFilter) : [], [view, filter, taskFilter]);
  const progress = useMemo(() => view ? orchestrationProgress(view, nowMs) : null, [view, nowMs]);
  const action = async (work: () => Promise<unknown>) => { setPending(true); setError(null); try { await work(); if (activeId) setView(await api.get(activeId)); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setPending(false); } };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const content = prompt.trim(); if (!content) return; setPending(true); setError(null); try { if (mode === "direct") { await onDirectSend(content); setPrompt(""); } else { const result = await api.create(agentId, { prompt: content, requestedMode: mode, modelStrategy, workerRouting: mode === "orchestrated" ? workerRouting : "adaptive" }); setActiveId(result.orchestration.id); setPrompt(""); } } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setPending(false); } };
  const orchestration = view?.orchestration;
  return <section className="orchestration-panel" aria-labelledby="orchestration-title">
    <header className="orch-header"><div><span className="eyebrow">Execution control</span><h2 id="orchestration-title">Direct or coordinated build</h2></div>{orchestration && <span className={`orch-state state-${orchestration.status}`} aria-live="polite">{statusLabel(orchestration.status)}</span>}</header>
    <form className="orch-composer" onSubmit={submit}>
      <fieldset className="orch-modes"><legend>Execution mode</legend>{modes.map((item) => <label key={item.id} className={mode === item.id ? "selected" : ""}><input type="radio" name="mode" value={item.id} checked={mode === item.id} onChange={() => setMode(item.id)} /><span><b>{item.label}</b><small>{item.help}</small></span></label>)}</fieldset>
      <label className="orch-select">Worker routing<select value={workerRouting} onChange={(event) => setWorkerRouting(event.target.value as WorkerRoutingPreference)} disabled={pending || mode !== "orchestrated"}><option value="adaptive">Adaptive</option><option value="one-worker">One worker</option><option value="multi-worker">Multi-worker</option></select><small>{mode === "orchestrated" ? workerRouting === "multi-worker" ? "Concurrent workers when paths are disjoint" : workerRouting === "one-worker" ? "Exactly one coordinated coding worker" : "Planner selects one or multiple workers" : "Select Orchestrated to control worker count"}</small></label>
      <label className="orch-model-strategy">Model strategy<select value={modelStrategy} onChange={(event) => setModelStrategy(event.target.value as ModelStrategy)} disabled={pending || mode === "direct"}><option value="mixed">Mixed — big + small workers</option><option value="big-only">Big model only — all roles</option><option value="small-only">Small model only — all roles</option></select><small>{mode === "direct" ? "Direct uses the configured runtime model" : modelStrategy === "big-only" ? `All roles: ${bigModelId ?? "configured big endpoint"}` : modelStrategy === "small-only" ? `All roles: ${smallModelId ?? "configured small endpoint"}` : `Planning/verification: ${bigModelId ?? "big endpoint"} · workers: ${smallModelId ?? "small endpoint"}`}</small></label>
      <label className="orch-prompt">Task<textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the outcome and constraints…" disabled={pending || agentStatus === "stopped"} /></label>
      <button className="button button-primary" disabled={pending || !prompt.trim() || agentStatus === "stopped"}>{pending ? "Working…" : mode === "direct" ? "Send direct" : "Review intent"}</button>
    </form>
    {error && <div className="orch-error" role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
    {view && <div className="orch-body">
      {view.activeDraft && <section className="orch-intent orch-card"><div className="orch-title-row"><div><span className="eyebrow">Intent revision {view.activeDraft.revision}</span><h3>{view.activeDraft.goal}</h3></div>{view.activeContract && <small>Contract v{view.activeContract.version} · {new Date(view.activeContract.confirmedAt).toLocaleString()}</small>}</div><div className="orch-intent-grid"><IntentList title="Requirements" values={view.activeDraft.requirements}/><IntentList title="Assumptions" values={view.activeDraft.assumptions}/><IntentList title="Non-goals" values={view.activeDraft.nonGoals}/><IntentList title="Architecture decisions" values={view.activeDraft.architectureDecisions}/><IntentList title="Manual expectations" values={view.activeDraft.manualExpectations}/><IntentList title="Material questions" values={view.activeDraft.materialQuestions} warning/></div>{orchestration?.estimate && <div className="orch-estimate"><span><b>{formatNumber(orchestration.estimate.inputTokenLow)}–{formatNumber(orchestration.estimate.inputTokenHigh)}</b> estimated input</span><span><b>{formatNumber(orchestration.estimate.outputTokenLow)}–{formatNumber(orchestration.estimate.outputTokenHigh)}</b> estimated output</span><span>{orchestration.estimate.estimatedUsdHigh === null ? "Pricing not configured" : formatEstimatedCost(orchestration.estimate.estimatedUsdHigh)}</span></div>}{orchestration?.status === "awaiting-confirmation" && <div className="orch-actions"><label>Revision or answers<textarea rows={2} value={revision} onChange={(event) => setRevision(event.target.value)} /></label><button className="button button-ghost" disabled={pending || !revision.trim()} onClick={() => void action(async () => { await api.reviseIntent(orchestration.id, revision); setRevision(""); })}>Revise</button><button className="button button-primary" disabled={pending || !canConfirmIntent(view)} title={view.activeDraft.materialQuestions.length ? "Answer material questions before confirming" : "Confirm this contract"} onClick={() => void action(() => api.confirm(orchestration.id))}>Confirm contract</button></div>}</section>}
      {view.pendingAmendment && <section className="orch-card orch-amendment"><h3>Material amendment needs you</h3><p>{view.pendingAmendment.reason}</p><button className="button button-primary" onClick={() => void action(() => api.confirmAmendment(view.orchestration.id, view.pendingAmendment!.id))}>Confirm amendment</button><button className="button button-ghost" onClick={() => void action(() => api.rejectAmendment(view.orchestration.id, view.pendingAmendment!.id))}>Reject</button></section>}
      {orchestration?.status === "ready" && <section className="orch-start orch-card"><div><h3>Plan ready</h3><p>{view.plan?.routeReason}</p></div><button className="button button-primary" disabled={pending} onClick={() => void action(() => api.start(orchestration.id))}>Start execution</button></section>}
      {orchestration && !["completed", "failed", "cancelled", "budget-exhausted"].includes(orchestration.status) && <div className="orch-control-row"><button className="button button-danger" disabled={pending} onClick={() => void action(() => api.cancel(orchestration.id))}>Cancel orchestration</button></div>}
      {progress && <section className="orch-card orch-progress" aria-live="polite"><div className="orch-title-row"><div><span className="eyebrow">Live execution · {progress.stage}</span><h3>{progress.phase}</h3></div><strong>{progress.percent}% of this stage</strong></div><div className="orch-progress-track" role="progressbar" aria-label={`${progress.phase} stage progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span style={{ width: `${progress.percent}%` }}/></div><p>{progress.detail}</p><div className="orch-progress-facts"><span><b>{progress.activeRole ? `${statusLabel(progress.activeRole)} model call` : "Local processing"}</b><small>Elapsed {formatDuration(progress.elapsedMs)}</small></span><span><b>{progress.activeRole ? progress.heartbeatFresh ? "Active heartbeat" : "No recent heartbeat" : "Processing current stage"}</b><small>Last activity {new Date(progress.lastActivityAt).toLocaleTimeString()}</small></span><span><b>{progress.activeRole && progress.timeoutRemainingMs !== null ? `${formatDuration(progress.timeoutRemainingMs)} before timeout` : "No model call active"}</b><small>The provider does not expose an exact ETA</small></span></div><small className="orch-progress-note">The bar resets for each stage and appears only while the system is working.</small></section>}
      <EvidenceGrid view={view} nowMs={nowMs}/>
      <section className="orch-card orch-wide"><div className="orch-title-row"><h3>Correlated timeline</h3><div className="orch-filters"><label>Event filter<select value={filter} onChange={(event) => setFilter(event.target.value as TimelineFilter)}><option value="all">All</option><option value="worker">Worker</option><option value="planner">Planner</option><option value="failure">Failures</option><option value="budget">Budget</option><option value="verification">Verification</option><option value="integration">Integration</option></select></label><label>Task<select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}><option value="">All tasks</option>{view.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div></div><ol className="orch-timeline">{events.map((event) => <li key={event.id}><time>{new Date(event.createdAt).toLocaleTimeString()}</time><div><strong>{event.actorRole} · {statusLabel(event.type)}</strong><p>{event.summary}</p>{event.modelId && <small>Model {event.modelId}</small>}</div></li>)}</ol></section>
      {(orchestration?.finalOutput || orchestration?.error) && <section className={`orch-card orch-result ${orchestration.status === "completed" ? "success" : "failure"}`}><h3>{orchestration.status === "completed" ? "Verified result" : statusLabel(orchestration.status)}</h3><p>{orchestration.finalOutput ?? orchestration.error}</p>{orchestration.status === "budget-exhausted" && <strong>Exact budget stop: {orchestration.error}</strong>}{view.cleanup && <small>Cleanup: {view.cleanup.status} — {view.cleanup.summary}</small>}</section>}
    </div>}
  </section>;
}

function IntentList({ title, values, warning = false }: { title: string; values: string[]; warning?: boolean }) { return <div className={warning && values.length ? "warning" : ""}><h4>{title}</h4>{values.length ? <ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul> : <p>None</p>}</div>; }
