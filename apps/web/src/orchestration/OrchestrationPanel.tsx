import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BenchmarkRecord, OrchestrationReadModel } from "./contracts";
import type { OrchestrationApi } from "./api-port";
import { createPoller } from "./polling";
import type { BackoffOptions, Scheduler } from "./polling";
import {
  budgetStopReason,
  confirmationGate,
  elapsedMsFor,
  evidenceCounters,
  extractBenchmarkId,
  extractOrchestrationId,
  formatTokens,
  isTerminalBenchmark,
  isTerminalStatus,
  modeToAction,
  normalizeBenchmark,
  normalizeReadModel,
  orchestrationStatusPresentation,
  safeText,
} from "./view-model";
import type { EventFilterKey, ExecutionMode } from "./view-model";
import { ModeSelector } from "./components/ModeSelector";
import {
  AmendmentReview,
  ContractSummary,
  IntentReview,
} from "./components/IntentReview";
import {
  CoordinationEvidence,
  FailurePanel,
  PlanBoard,
  VerificationPanel,
} from "./components/PlanBoard";
import { EvidenceTimeline } from "./components/EvidenceTimeline";
import { UsagePanel } from "./components/UsagePanel";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { StatusBadge } from "./components/StatusBadge";

export type AgentLifecycleStatus = "ready" | "busy" | "stopped" | "error";

export interface OrchestrationSystemSummary {
  runtime?: string | null;
  arkModel?: string | null;
  arkConfigured?: boolean;
  codexAvailable?: boolean;
}

export interface OrchestrationPanelProps {
  /** The Agent currently selected in the Playground. */
  agentId: string;
  /** Authoritative lifecycle status from the host application. */
  agentStatus: AgentLifecycleStatus;
  agentName?: string;
  /** Injected typed adapter over the control plane. */
  api: OrchestrationApi;
  /**
   * The host application's existing direct send path. When omitted, Direct mode
   * is disabled rather than faked.
   */
  onDirectSend?: (prompt: string) => Promise<void> | void;
  /** Runtime/system summary from `/api/system`, shown as context. */
  system?: OrchestrationSystemSummary | null;
  /** Resume an orchestration the host already knows about. */
  initialOrchestrationId?: string | null;
  /**
   * Called whenever an orchestration reaches a terminal state, so the host can
   * refresh authoritative Agent and Run state instead of guessing.
   */
  onTerminalState?: (view: OrchestrationReadModel) => void;
  /** Test seams. */
  pollingOptions?: Partial<BackoffOptions>;
  scheduler?: Scheduler;
  now?: () => number;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return safeText(reason.message, 400);
  return safeText(String(reason), 400);
}

function budgetSummaryText(view: OrchestrationReadModel | null): string {
  if (!view) return "not configured";
  const budget = view.orchestration.budget;
  const parts: string[] = [];
  if (budget.maxInputTokens) parts.push(formatTokens(budget.maxInputTokens) + " input tokens");
  if (budget.maxOutputTokens) parts.push(formatTokens(budget.maxOutputTokens) + " output tokens");
  if (budget.maxEstimatedUsd != null) parts.push("$" + budget.maxEstimatedUsd.toFixed(2));
  if (budget.maxModelCalls) parts.push(budget.maxModelCalls + " model calls");
  if (budget.maxWallClockMs) parts.push(Math.round(budget.maxWallClockMs / 60_000) + " min");
  return parts.length > 0 ? parts.join(" · ") : "no hard limit configured";
}

/**
 * The orchestration experience mounted inside the existing Playground.
 *
 * It never calls `fetch` directly and never renders optimistic server state:
 * every displayed value comes from the injected `OrchestrationApi` and is
 * refreshed from the control plane's persisted read model.
 */
export function OrchestrationPanel({
  agentId,
  agentStatus,
  agentName,
  api,
  onDirectSend,
  system,
  initialOrchestrationId = null,
  onTerminalState,
  pollingOptions,
  scheduler,
  now = () => Date.now(),
}: OrchestrationPanelProps) {
  const [mode, setMode] = useState<ExecutionMode>("auto");
  const [prompt, setPrompt] = useState("");
  const [orchestrationId, setOrchestrationId] = useState<string | null>(
    initialOrchestrationId,
  );
  const [view, setView] = useState<OrchestrationReadModel | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkRecord | null>(null);
  const [benchmarkId, setBenchmarkId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<EventFilterKey>("all");
  const [taskFilter, setTaskFilter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const terminalNotified = useRef<string | null>(null);
  const onTerminalRef = useRef(onTerminalState);
  onTerminalRef.current = onTerminalState;

  // Switching Agent must clear UI state, and its effect cleanup stops polling.
  useEffect(() => {
    setOrchestrationId(initialOrchestrationId);
    setView(null);
    setBenchmark(null);
    setBenchmarkId(null);
    setAnswers({});
    setError(null);
    terminalNotified.current = null;
  }, [agentId, initialOrchestrationId]);

  useEffect(() => {
    if (!orchestrationId) return;
    const poller = createPoller<OrchestrationReadModel | null>({
      poll: async () => normalizeReadModel(await api.getOrchestration(orchestrationId)),
      isTerminal: (next) => next != null && isTerminalStatus(next.orchestration.status),
      onData: (next) => {
        if (!next) return;
        // A recoverable failure never clears this; only new data replaces it.
        setView(next);
        setError(null);
        setAnnouncement(
          "Orchestration " +
            orchestrationStatusPresentation(next.orchestration.status).label,
        );
        if (
          isTerminalStatus(next.orchestration.status) &&
          terminalNotified.current !== next.orchestration.id
        ) {
          terminalNotified.current = next.orchestration.id;
          onTerminalRef.current?.(next);
        }
      },
      onError: (reason, state) => {
        setError(
          errorMessage(reason) +
            (state.consecutiveErrors > 1
              ? " · retrying with backoff (" + state.consecutiveErrors + " failures)"
              : ""),
        );
      },
      ...(pollingOptions ? { options: pollingOptions } : {}),
      ...(scheduler ? { scheduler } : {}),
    });
    poller.start();
    return () => poller.stop();
  }, [api, orchestrationId, pollingOptions, scheduler]);

  useEffect(() => {
    if (!benchmarkId) return;
    const poller = createPoller<BenchmarkRecord | null>({
      poll: async () => normalizeBenchmark(await api.getBenchmark(benchmarkId)),
      isTerminal: (next) => next != null && isTerminalBenchmark(next),
      onData: (next) => {
        if (next) setBenchmark(next);
      },
      onError: (reason) => setError(errorMessage(reason)),
      ...(pollingOptions ? { options: pollingOptions } : {}),
      ...(scheduler ? { scheduler } : {}),
    });
    poller.start();
    return () => poller.stop();
  }, [api, benchmarkId, pollingOptions, scheduler]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, description: string) => {
      setBusy(true);
      setError(null);
      try {
        return await action();
      } catch (reason) {
        setError(description + ": " + errorMessage(reason));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const submit = useCallback(async () => {
    const content = prompt.trim();
    if (!content) return;
    const action = modeToAction(mode);
    if (action.kind === "direct") {
      if (!onDirectSend) return;
      const sent = await runAction(
        async () => onDirectSend(content),
        "Direct send failed",
      );
      if (sent !== null) setPrompt("");
      return;
    }
    const response = await runAction(
      () => api.createOrchestration(agentId, {
        prompt: content,
        requestedMode: action.requestedMode,
      }),
      "Could not start the orchestration",
    );
    if (response === null) return;
    const nextId = extractOrchestrationId(response);
    if (!nextId) {
      setError("The control plane did not return an orchestration ID.");
      return;
    }
    setPrompt("");
    setAnswers({});
    terminalNotified.current = null;
    setView(null);
    setOrchestrationId(nextId);
  }, [agentId, api, mode, onDirectSend, prompt, runAction]);

  const gate = useMemo(() => confirmationGate(view, answers), [view, answers]);

  const confirm = useCallback(async () => {
    if (!orchestrationId || !view?.intentDraft || !gate.canConfirm) return;
    const answered = view.intentDraft.materialQuestions.map(
      (question) => question + " → " + (answers[question] ?? ""),
    );
    await runAction(
      () =>
        api.confirmIntent(orchestrationId, {
          confirm: true,
          ...(answered.length > 0 ? { answers: answered } : {}),
        }),
      "Confirmation failed",
    );
  }, [answers, api, gate.canConfirm, orchestrationId, runAction, view]);

  const revise = useCallback(
    async (feedback: string) => {
      if (!orchestrationId) return;
      await runAction(
        () => api.reviseIntent(orchestrationId, { feedback }),
        "Revision failed",
      );
    },
    [api, orchestrationId, runAction],
  );

  const start = useCallback(async () => {
    if (!orchestrationId) return;
    await runAction(() => api.startOrchestration(orchestrationId), "Start failed");
  }, [api, orchestrationId, runAction]);

  const cancel = useCallback(async () => {
    if (!orchestrationId) return;
    await runAction(
      () => api.cancelOrchestration(orchestrationId, "cancelled from the Playground"),
      "Cancel failed",
    );
  }, [api, orchestrationId, runAction]);

  const runBenchmark = useCallback(
    async (benchmarkPrompt: string) => {
      const response = await runAction(
        () => api.createBenchmark(agentId, { prompt: benchmarkPrompt }),
        "Could not start the benchmark",
      );
      if (response === null) return;
      const id = extractBenchmarkId(response);
      if (!id) {
        setError("The control plane did not return a benchmark ID.");
        return;
      }
      setBenchmark(normalizeBenchmark(response));
      setBenchmarkId(id);
    },
    [agentId, api, runAction],
  );

  const cancelBenchmark = useCallback(async () => {
    if (!benchmarkId) return;
    await runAction(() => api.cancelBenchmark(benchmarkId), "Benchmark cancel failed");
  }, [api, benchmarkId, runAction]);

  const status = view?.orchestration.status ?? null;
  const active = status != null && !isTerminalStatus(status);
  const elapsedMs = useMemo(() => (view ? elapsedMsFor(view, now()) : 0), [now, view]);
  const stopReason = useMemo(() => (view ? budgetStopReason(view) : null), [view]);

  const submitDisabledReason =
    agentStatus === "stopped"
      ? "Start this Agent before submitting work."
      : agentStatus === "busy"
        ? "This Agent already has an active run."
        : active
          ? "An orchestration is already in progress."
          : mode === "direct" && !onDirectSend
            ? "Direct send is not wired up in this build."
            : null;

  return (
    <div className="orch">
      <p className="orch-visually-hidden" aria-live="polite">
        {announcement}
      </p>

      {error && (
        <div className="orch-error" role="alert">
          <span>{error}</span>
          <button type="button" className="button button-ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <ModeSelector
        mode={mode}
        onModeChange={setMode}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSubmit={() => void submit()}
        submitting={busy}
        disabled={submitDisabledReason != null}
        disabledReason={submitDisabledReason}
        directAvailable={onDirectSend != null}
      />

      {view && (
        <section className="orch-panel" aria-labelledby="orch-overview-heading">
          <header>
            <div>
              <span className="eyebrow">
                Orchestration for {agentName ?? "this Agent"}
              </span>
              <h3 id="orch-overview-heading">{view.orchestration.prompt}</h3>
            </div>
            <StatusBadge
              presentation={orchestrationStatusPresentation(view.orchestration.status)}
            />
          </header>
          <dl className="orch-facts">
            <div className="orch-fact">
              <dt>Requested mode</dt>
              <dd>{view.orchestration.requestedMode}</dd>
            </div>
            <div className="orch-fact">
              <dt>Selected route</dt>
              <dd>{view.orchestration.selectedMode ?? "not decided yet"}</dd>
            </div>
            <div className="orch-fact">
              <dt>Hard budget</dt>
              <dd>{budgetSummaryText(view)}</dd>
            </div>
            <div className="orch-fact">
              <dt>Runtime</dt>
              <dd>
                {system?.runtime ?? "unknown"}
                {system?.arkModel ? " · " + system.arkModel : ""}
              </dd>
            </div>
          </dl>
          {view.orchestration.error && (
            <p className="orch-note">{view.orchestration.error}</p>
          )}
          <div className="orch-actions">
            {active && (
              <button className="button button-danger" onClick={() => void cancel()} disabled={busy}>
                Cancel orchestration
              </button>
            )}
            <button
              className="button button-ghost"
              onClick={() => {
                setMode("direct");
                setOrchestrationId(null);
                setView(null);
              }}
              disabled={busy}
            >
              Return to direct Playground
            </button>
          </div>
        </section>
      )}

      {view?.pendingAmendment && view.pendingAmendment.status === "pending" && (
        <AmendmentReview
          amendment={view.pendingAmendment}
          busy={busy}
          onConfirm={() =>
            void runAction(
              () =>
                api.confirmAmendment(
                  view.orchestration.id,
                  view.pendingAmendment!.id,
                ),
              "Amendment confirmation failed",
            )
          }
          onReject={(reason) =>
            void runAction(
              () =>
                api.rejectAmendment(
                  view.orchestration.id,
                  view.pendingAmendment!.id,
                  reason || undefined,
                ),
              "Amendment rejection failed",
            )
          }
        />
      )}

      {view?.intentDraft && view.orchestration.status === "awaiting-confirmation" && (
        <IntentReview
          draft={view.intentDraft}
          estimate={view.orchestration.estimate}
          budgetSummary={budgetSummaryText(view)}
          gate={gate}
          answers={answers}
          onAnswerChange={(question, answer) =>
            setAnswers((current) => ({ ...current, [question]: answer }))
          }
          onRevise={(request) => void revise(request)}
          onConfirm={() => void confirm()}
          busy={busy}
        />
      )}

      {view?.contract && <ContractSummary contract={view.contract} />}

      {view && (view.plan || view.tasks.length > 0 || status === "ready") && (
        <PlanBoard
          plan={view.plan}
          view={view}
          canStart={status === "ready"}
          onStart={() => void start()}
          busy={busy}
        />
      )}

      {view && (
        <>
          <CoordinationEvidence
            artifacts={view.artifacts}
            attempts={view.attempts}
            contextPackets={view.contextPackets}
            workspaceDispositions={view.workspaceDispositions}
          />
          <VerificationPanel records={view.verifications} />
          <FailurePanel packets={view.failurePackets} />
          <UsagePanel
            usage={view.orchestration.usage}
            budget={view.orchestration.budget}
            estimate={view.orchestration.estimate}
            counters={evidenceCounters(view)}
            elapsedMs={elapsedMs}
            budgetStopReason={stopReason}
          />
          <EvidenceTimeline
            events={view.events}
            tasks={view.tasks}
            filter={filter}
            onFilterChange={setFilter}
            taskFilter={taskFilter}
            onTaskFilterChange={setTaskFilter}
          />
          {view.orchestration.finalOutput && (
            <section className="orch-panel" aria-labelledby="orch-output-heading">
              <header>
                <div>
                  <span className="eyebrow">Published result</span>
                  <h3 id="orch-output-heading">Final output</h3>
                </div>
              </header>
              <p>{view.orchestration.finalOutput}</p>
            </section>
          )}
        </>
      )}

      <BenchmarkPanel
        record={benchmark}
        running={benchmark != null && !isTerminalBenchmark(benchmark)}
        onRun={(benchmarkPrompt) => void runBenchmark(benchmarkPrompt)}
        onCancel={() => void cancelBenchmark()}
        busy={busy}
        disabled={agentStatus !== "ready" || active}
        disabledReason={
          agentStatus !== "ready"
            ? "The Agent must be ready to run a benchmark."
            : active
              ? "Finish or cancel the active orchestration first."
              : null
        }
      />
    </div>
  );
}

export default OrchestrationPanel;
