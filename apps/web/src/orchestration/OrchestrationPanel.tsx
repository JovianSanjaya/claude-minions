import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestrationApi } from "./api-port";
import type { OrchestrationReadModel } from "./contracts";
import { AmendmentBanner } from "./components/AmendmentBanner";
import { ContractView } from "./components/ContractView";
import { ExecutionTimeline } from "./components/ExecutionTimeline";
import { IntentReview } from "./components/IntentReview";
import { ModeSelector } from "./components/ModeSelector";
import { UsageSummary } from "./components/UsageSummary";
import { createPoller, type Poller } from "./polling";
import { describeStatus, isTerminalStatus, modeToRequestedMode, type PlaygroundMode } from "./view-model";

export interface OrchestrationPanelProps {
  agentId: string;
  agentStatus: "ready" | "busy" | "stopped" | "error";
  api: OrchestrationApi;
  /** Delegates a "direct" mode submission to the existing Playground chat path instead of creating an orchestration. */
  onDirectSend?: (prompt: string) => Promise<void> | void;
  systemSummary?: string;
  initialOrchestrationId?: string;
}

export function OrchestrationPanel({
  agentId,
  agentStatus,
  api,
  onDirectSend,
  systemSummary,
  initialOrchestrationId,
}: OrchestrationPanelProps) {
  const [mode, setMode] = useState<PlaygroundMode>("auto");
  const [prompt, setPrompt] = useState("");
  const [orchestrationId, setOrchestrationId] = useState<string | null>(initialOrchestrationId ?? null);
  const [readModel, setReadModel] = useState<OrchestrationReadModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollerRef = useRef<Poller | null>(null);
  const orchestrationIdRef = useRef<string | null>(orchestrationId);
  orchestrationIdRef.current = orchestrationId;

  const stopPolling = useCallback(() => {
    pollerRef.current?.stop();
    pollerRef.current = null;
  }, []);

  const refreshOnce = useCallback(async (id: string) => {
    try {
      const model = await api.get(id);
      if (orchestrationIdRef.current === id) setReadModel(model);
      return model;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    }
  }, [api]);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      const poller = createPoller(
        () => api.get(id),
        (model) => {
          if (orchestrationIdRef.current === id) setReadModel(model);
        },
        (reason) => setError(reason instanceof Error ? reason.message : String(reason)),
        { intervalMs: 1200, maxIntervalMs: 10_000, isTerminal: (model) => isTerminalStatus(model.orchestration.status) },
      );
      pollerRef.current = poller;
      poller.start();
    },
    [api, stopPolling],
  );

  // Reset all orchestration state when switching Agents; never carry stale
  // evidence across Agents. If no explicit orchestration was requested,
  // resume the Agent's own most recent non-terminal one (if any) so a
  // still-active orchestration — including one stuck after a failure, e.g.
  // elaboration never reaching a terminal status — stays reachable and
  // cancellable after a reload, instead of being silently orphaned from the
  // UI while still blocking new orchestrations for that Agent server-side.
  useEffect(() => {
    stopPolling();
    setReadModel(null);
    setError(null);
    setPrompt("");
    if (initialOrchestrationId) {
      setOrchestrationId(initialOrchestrationId);
      return;
    }
    setOrchestrationId(null);
    let cancelled = false;
    api
      .list(agentId)
      .then(({ orchestrations }) => {
        if (cancelled) return;
        const active = orchestrations.find((item) => !isTerminalStatus(item.status));
        if (active) setOrchestrationId(active.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    if (orchestrationId) startPolling(orchestrationId);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestrationId]);

  useEffect(() => stopPolling, [stopPolling]);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "direct") {
        await onDirectSend?.(prompt.trim());
        setPrompt("");
        return;
      }
      const { orchestration } = await api.create(agentId, { prompt: prompt.trim(), requestedMode: modeToRequestedMode(mode) });
      setPrompt("");
      setOrchestrationId(orchestration.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [agentId, api, mode, onDirectSend, prompt]);

  const withBusyGuard = useCallback(
    (action: () => Promise<unknown>) => async () => {
      if (!orchestrationId) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        await refreshOnce(orchestrationId);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [orchestrationId, refreshOnce],
  );

  const handleAnswer = useCallback(
    (questionId: string, answer: { optionId?: string; freeText?: string }) =>
      withBusyGuard(() => api.answerClarification(orchestrationId as string, questionId, answer))(),
    [api, orchestrationId, withBusyGuard],
  );
  const handleRevise = useCallback(
    (note: string) => withBusyGuard(() => api.reviseIntent(orchestrationId as string, note))(),
    [api, orchestrationId, withBusyGuard],
  );
  const handleConfirm = useCallback(() => withBusyGuard(() => api.confirm(orchestrationId as string))(), [api, orchestrationId, withBusyGuard]);
  const handleStart = useCallback(() => withBusyGuard(() => api.start(orchestrationId as string))(), [api, orchestrationId, withBusyGuard]);
  const handleCancel = useCallback(() => withBusyGuard(() => api.cancel(orchestrationId as string))(), [api, orchestrationId, withBusyGuard]);
  const handleConfirmAmendment = useCallback(
    (amendmentId: string) => withBusyGuard(() => api.confirmAmendment(orchestrationId as string, amendmentId))(),
    [api, orchestrationId, withBusyGuard],
  );
  const handleRejectAmendment = useCallback(
    (amendmentId: string) => withBusyGuard(() => api.rejectAmendment(orchestrationId as string, amendmentId))(),
    [api, orchestrationId, withBusyGuard],
  );

  const orchestration = readModel?.orchestration ?? null;
  const status = orchestration ? describeStatus(orchestration.status) : null;

  return (
    <div className="orch-panel">
      <ModeSelector
        mode={mode}
        onModeChange={setMode}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSubmit={handleSubmit}
        disabled={agentStatus !== "ready" || busy}
        busy={busy}
      />

      {systemSummary && <p className="orch-system-summary">{systemSummary}</p>}
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {orchestration && readModel && (
        <div className="orch-body">
          <div className="orch-status-row">
            <span className={"orch-status-pill orch-tone-" + status?.tone}>{status?.label}</span>
            {!isTerminalStatus(orchestration.status) && (
              <button type="button" className="button button-ghost" disabled={busy} onClick={handleCancel}>
                Cancel
              </button>
            )}
          </div>

          {readModel.pendingAmendment && (
            <AmendmentBanner
              amendment={readModel.pendingAmendment}
              busy={busy}
              onConfirm={() => handleConfirmAmendment(readModel.pendingAmendment!.id)}
              onReject={() => handleRejectAmendment(readModel.pendingAmendment!.id)}
            />
          )}

          {(orchestration.status === "drafting-intent" || orchestration.status === "awaiting-confirmation") && (
            <IntentReview
              readModel={readModel}
              orchestration={orchestration}
              onAnswer={handleAnswer}
              onRevise={handleRevise}
              onConfirm={handleConfirm}
              busy={busy}
            />
          )}

          {readModel.activeContract &&
            (orchestration.status === "planning" || orchestration.status === "ready") &&
            !readModel.pendingAmendment && (
              <ContractView
                contract={readModel.activeContract}
                orchestration={orchestration}
                tasks={readModel.tasks}
                onStart={handleStart}
                busy={busy}
              />
            )}

          {orchestration.finalOutput && <p className="orch-final-output">{orchestration.finalOutput}</p>}
          {orchestration.error && <p className="orch-error-summary">{orchestration.error}</p>}

          <UsageSummary orchestration={orchestration} />
          <ExecutionTimeline readModel={readModel} />
        </div>
      )}
    </div>
  );
}
