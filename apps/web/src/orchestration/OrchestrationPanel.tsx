import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRun, Message } from "../types";
import type { OrchestrationApi } from "./api-port";
import type { OrchestrationReadModel, RequestedMode } from "./contracts";
import { ClarificationQuestionCard } from "./components/ClarificationQuestionCard";
import { DetailsPage } from "./components/DetailsPage";
import { IntegrationResultPage } from "./components/IntegrationResultPage";
import { OrchestrationPage } from "./components/OrchestrationPage";
import { PlanBoard } from "./components/PlanBoard";
import { UsagePanel } from "./components/UsagePanel";
import { pollOrchestration } from "./polling";
import {
  WORKFLOW_STEPS,
  budgetStopReason,
  elapsedMsFor,
  evidenceCounters,
  isTerminal,
  orchestrationProgress,
  statusLabel,
  toClarificationQuestion,
  workflowState,
  type WorkflowStepId,
} from "./view-model";
import "./orchestration.css";

interface Props {
  agentId: string;
  agentName: string;
  agentInstructions: string;
  agentStatus: "ready" | "busy" | "stopped" | "error";
  api: OrchestrationApi;
  directMessages: Message[];
  directRun: AgentRun | null;
  sessionConnected: boolean;
  sandboxMode: string;
  starterPrompts: string[];
  onDirectSend(prompt: string): Promise<void>;
  onTerminal?(): void;
}

const modes: Array<{ id: RequestedMode; label: string }> = [
  { id: "direct", label: "Direct" },
  { id: "auto", label: "Auto" },
  { id: "orchestrated", label: "Orchestrated" },
];

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function OrchestrationPanel({
  agentId,
  agentName,
  agentInstructions,
  agentStatus,
  api,
  directMessages,
  directRun,
  sessionConnected,
  sandboxMode,
  starterPrompts,
  onDirectSend,
  onTerminal,
}: Props) {
  const [mode, setMode] = useState<RequestedMode>("auto");
  const [prompt, setPrompt] = useState("");
  const [view, setView] = useState<OrchestrationReadModel | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<WorkflowStepId | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [followingLatest, setFollowingLatest] = useState(true);
  const autoStarted = useRef(new Set<string>());
  const messagesContainer = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);

  useEffect(() => {
    setView(null);
    setActiveId(null);
    setAnswers([]);
    setError(null);
    followLatest.current = true;
    setFollowingLatest(true);
    void api
      .list(agentId)
      .then(({ orchestrations }) => {
        const current =
          orchestrations.find((item) => !isTerminal(item.status)) ?? orchestrations[0];
        if (current) setActiveId(current.id);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [agentId, api]);

  useEffect(() => {
    if (!activeId) return;
    const handle = pollOrchestration(
      api,
      activeId,
      (next) => {
        setView(next);
        if (isTerminal(next.orchestration.status)) onTerminal?.();
      },
      (reason) => setError(`Refresh delayed: ${reason.message}`),
    );
    return () => handle.stop();
  }, [activeId, api, onTerminal]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!followLatest.current) return;
    const frame = window.requestAnimationFrame(() => {
      const container = messagesContainer.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [directMessages.length, directRun?.status, view?.orchestration.status, answers.length]);

  useEffect(() => {
    if (!view || view.orchestration.status !== "ready") return;
    const id = view.orchestration.id;
    if (autoStarted.current.has(id)) return;
    autoStarted.current.add(id);
    setPending(true);
    void api
      .start(id)
      .then(() => api.get(id))
      .then(setView)
      .catch((reason) => {
        autoStarted.current.delete(id);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setPending(false));
  }, [api, view]);

  const progress = useMemo(
    () => (view ? orchestrationProgress(view, nowMs) : null),
    [view, nowMs],
  );
  const steps = view ? workflowState(view) : null;
  const questions =
    view?.activeDraft?.materialQuestions.map(toClarificationQuestion) ?? [];
  const currentQuestion = questions[answers.length] ?? null;
  const orchestrationBusy = Boolean(view && !isTerminal(view.orchestration.status));

  const refresh = async () => {
    if (activeId) setView(await api.get(activeId));
  };

  const runAction = async (work: () => Promise<unknown>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await work();
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setPending(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = prompt.trim();
    if (!content) return;
    followLatest.current = true;
    setFollowingLatest(true);
    setPending(true);
    setError(null);
    try {
      if (mode === "direct") {
        await onDirectSend(content);
      } else {
        const result = await api.create(agentId, {
          prompt: content,
          requestedMode: mode,
        });
        setAnswers([]);
        setActivePage(null);
        setView(null);
        setActiveId(result.orchestration.id);
      }
      setPrompt("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const answerQuestion = async (answer: string) => {
    if (!view || !currentQuestion) return;
    followLatest.current = true;
    setFollowingLatest(true);
    const nextAnswers = [...answers, answer];
    setAnswers(nextAnswers);
    if (nextAnswers.length < questions.length) return;
    const confirmed = await runAction(() =>
      api.confirm(view.orchestration.id, undefined, nextAnswers),
    );
    if (!confirmed) setAnswers(answers);
  };

  const confirmWithoutQuestions = async () => {
    if (!view) return;
    await runAction(() => api.confirm(view.orchestration.id));
  };

  const openStep = (stepId: WorkflowStepId, index: number) => {
    if (!steps || index > steps.reachedIndex) return;
    setActivePage(stepId);
  };

  const handleMessagesScroll = () => {
    const container = messagesContainer.current;
    if (!container) return;
    const next = container.scrollHeight - container.scrollTop - container.clientHeight < 72;
    followLatest.current = next;
    setFollowingLatest(next);
  };

  const jumpToLatest = () => {
    followLatest.current = true;
    setFollowingLatest(true);
    const container = messagesContainer.current;
    if (container) container.scrollTop = container.scrollHeight;
  };

  return (
    <>
      <section className="playground orchestration-chat" aria-labelledby="orchestration-title">
        <div className="playground-topbar">
          <div>
            <span className="eyebrow">Playground · Execution control</span>
            <h2 id="orchestration-title">Build something with {agentName}</h2>
          </div>
          <div className="session-info">
            <span className="pulse" />
            {sessionConnected ? "Session connected" : "New session"}
          </div>
        </div>

        <div className="messages" ref={messagesContainer} onScroll={handleMessagesScroll}>
          {directMessages.length === 0 && !directRun && !view ? (
            <div className="welcome">
              <div className="welcome-orbit">
                <div>⌁</div>
              </div>
              <h3>What should {agentName} build?</h3>
              <p>
                Use Auto for clarification, planning, accounting, coordinated agents, and
                verified integration in one conversation.
              </p>
              <div className="prompt-grid">
                {starterPrompts.map((item) => (
                  <button key={item} onClick={() => setPrompt(item)}>
                    <span>↗</span>
                    {item}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            directMessages.map((message) => (
              <article className={`message message-${message.role}`} key={message.id}>
                <div className="message-meta">
                  <strong>{message.role === "user" ? "You" : agentName}</strong>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <div className="message-body">{message.content}</div>
              </article>
            ))
          )}

          {view && (
            <article className="message message-user orch-user-request">
              <div className="message-meta">
                <strong>You</strong>
                <span>{formatTime(view.orchestration.createdAt)}</span>
              </div>
              <div className="message-body">{view.orchestration.prompt}</div>
            </article>
          )}

          {view?.orchestration.status === "drafting-intent" && (
            <AssistantMessage agentName={agentName} meta="reviewing the request">
              <div className="thinking-row">
                <span className="spinner" />
                Preparing the run details and checking for material choices…
              </div>
            </AssistantMessage>
          )}

          {view?.orchestration.status === "awaiting-confirmation" && currentQuestion && (
            <AssistantMessage agentName={agentName} meta="needs one detail">
              <ClarificationQuestionCard
                key={currentQuestion.id}
                question={currentQuestion}
                disabled={pending}
                onAnswer={(answer) => void answerQuestion(answer)}
              />
            </AssistantMessage>
          )}

          {answers.map((answer, index) => (
            <article className="message message-user orch-answer" key={`${index}:${answer}`}>
              <div className="message-meta">
                <strong>You</strong>
                <span>confirmation {index + 1}</span>
              </div>
              <div className="message-body">{answer}</div>
            </article>
          ))}

          {view?.orchestration.status === "awaiting-confirmation" &&
            questions.length === 0 && (
              <AssistantMessage agentName={agentName} meta="ready for confirmation">
                <p>I have enough detail to plan and execute this run.</p>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending}
                  onClick={() => void confirmWithoutQuestions()}
                >
                  Confirm and execute
                </button>
              </AssistantMessage>
            )}

          {view && progress && !["drafting-intent", "awaiting-confirmation"].includes(view.orchestration.status) && (
            <AssistantMessage agentName={agentName} meta={statusLabel(view.orchestration.status)}>
              <div className="orch-executing-head">
                <div>
                  <strong>{progress.percent === 100 ? "Complete" : "Executing…"}</strong>
                  <button type="button" onClick={() => setActivePage("orchestration")}>
                    Open live timeline ↗
                  </button>
                </div>
                <b>{progress.percent}%</b>
              </div>
              <div
                className="orch-progress-track"
                role="progressbar"
                aria-label="Overall orchestration progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
              >
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <p className="orch-note">{progress.detail}</p>
              {view.orchestration.status === "ready" && error && (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={pending}
                  onClick={() => {
                    autoStarted.current.add(view.orchestration.id);
                    void runAction(() => api.start(view.orchestration.id));
                  }}
                >
                  Retry start
                </button>
              )}
              <nav className="orch-step-nav" aria-label="Execution pages">
                {WORKFLOW_STEPS.map((step, index) => {
                  const reached = Boolean(steps && index <= steps.reachedIndex);
                  return (
                    <button
                      type="button"
                      key={step.id}
                      disabled={!reached}
                      data-active={steps?.activeIndex === index}
                      data-reached={reached}
                      onClick={() => openStep(step.id, index)}
                    >
                      <span>{index + 1}</span>
                      {step.label}
                    </button>
                  );
                })}
              </nav>
              <div className="orch-live-facts">
                <span>{progress.phase}</span>
                <span>Elapsed {Math.round(progress.elapsedMs / 1_000)}s</span>
                <span>
                  {progress.activeRole ? `${progress.activeRole} model active` : "Local control step"}
                </span>
              </div>
            </AssistantMessage>
          )}

          {view && isTerminal(view.orchestration.status) && (
            <AssistantMessage agentName={agentName} meta={statusLabel(view.orchestration.status)}>
              <div className={`orch-inline-result state-${view.orchestration.status}`}>
                <strong>
                  {view.orchestration.status === "completed"
                    ? "Verified result ready"
                    : statusLabel(view.orchestration.status)}
                </strong>
                <p>
                  {view.orchestration.finalOutput ??
                    view.orchestration.error ??
                    "The run ended without a result summary."}
                </p>
                {steps && steps.reachedIndex >= 4 && (
                  <button type="button" onClick={() => setActivePage("integration")}>
                    Open Integration (Result) ↗
                  </button>
                )}
              </div>
            </AssistantMessage>
          )}

          {directRun && ["queued", "running"].includes(directRun.status) && (
            <AssistantMessage agentName={agentName} meta="working in the Agent workspace">
              <div className="thinking-row">
                <span className="spinner" />
                Codex is reading, editing, or running commands…
              </div>
            </AssistantMessage>
          )}
          {directRun?.status === "failed" && (
            <article className="run-error">
              <strong>Run failed</strong>
              <span>{directRun.error}</span>
            </article>
          )}
          {error && (
            <div className="orch-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>

        {!followingLatest && (
          <button type="button" className="orch-jump-latest" onClick={jumpToLatest}>
            <span aria-hidden="true">↓</span>
            Jump to latest
          </button>
        )}

        <form className="composer orch-chat-composer" onSubmit={submit}>
          <div className="orch-inline-modes" aria-label="Execution mode">
            {modes.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={mode === item.id}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              agentStatus === "stopped"
                ? "Start this Agent to continue…"
                : mode === "direct"
                  ? "Send a direct message…"
                  : "Describe what you want the Agent team to build…"
            }
            disabled={
              pending ||
              orchestrationBusy ||
              agentStatus === "stopped" ||
              agentStatus === "busy" ||
              Boolean(directRun && ["queued", "running"].includes(directRun.status))
            }
            rows={3}
          />
          <div className="composer-footer">
            <span>
              Enter to send · {mode} mode · {sandboxMode}
            </span>
            <button
              className="send-button"
              disabled={
                !prompt.trim() ||
                pending ||
                orchestrationBusy ||
                agentStatus === "stopped" ||
                agentStatus === "busy" ||
                Boolean(directRun && ["queued", "running"].includes(directRun.status))
              }
              aria-label="Send message"
            >
              ↑
            </button>
          </div>
        </form>
      </section>

      {view && activePage && (
        <div className="orch-page-backdrop" onMouseDown={() => setActivePage(null)}>
          <section
            className="orch-page-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={WORKFLOW_STEPS.find((step) => step.id === activePage)?.label}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="orch-page-header">
              <nav className="orch-step-nav" aria-label="Execution pages">
                {WORKFLOW_STEPS.map((step, index) => {
                  const reached = Boolean(steps && index <= steps.reachedIndex);
                  return (
                    <button
                      type="button"
                      key={step.id}
                      disabled={!reached}
                      data-active={activePage === step.id}
                      data-reached={reached}
                      onClick={() => openStep(step.id, index)}
                    >
                      <span>{index + 1}</span>
                      {step.label}
                    </button>
                  );
                })}
              </nav>
              <button
                type="button"
                className="orch-page-close"
                aria-label="Close execution page"
                onClick={() => setActivePage(null)}
              >
                ×
              </button>
            </header>
            <div className="orch-page-content">
              {activePage === "details" && (
                <DetailsPage view={view} agentInstructions={agentInstructions} />
              )}
              {activePage === "planner" && <PlanBoard view={view} />}
              {activePage === "accounting" && (
                <UsagePanel
                  usage={view.usage}
                  budget={view.orchestration.budget}
                  estimate={view.orchestration.estimate}
                  counters={evidenceCounters(view)}
                  elapsedMs={elapsedMsFor(view, nowMs)}
                  budgetStopReason={budgetStopReason(view)}
                />
              )}
              {activePage === "orchestration" && <OrchestrationPage view={view} />}
              {activePage === "integration" && <IntegrationResultPage view={view} />}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function AssistantMessage({
  agentName,
  meta,
  children,
}: {
  agentName: string;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <article className="message message-assistant orch-assistant-message">
      <div className="message-meta">
        <strong>{agentName}</strong>
        <span>{meta}</span>
      </div>
      <div className="message-body">{children}</div>
    </article>
  );
}
