import type {
  ActorRole,
  BudgetPolicy,
  ClarificationQuestionView,
  CostEstimate,
  ModelRole,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationStatus,
  OrchestrationSummary,
  OrchestrationTaskStatus,
  UsageLedger,
} from "./contracts";
import type { Message } from "../types";

export const terminalStatuses = new Set<OrchestrationStatus>([
  "budget-exhausted",
  "completed",
  "failed",
  "cancelled",
]);
export const isTerminal = (status: OrchestrationStatus) => terminalStatuses.has(status);
export const canConfirmIntent = (view: OrchestrationReadModel | null) =>
  Boolean(
    view?.orchestration.status === "awaiting-confirmation" &&
      view.activeDraft &&
      view.activeDraft.materialQuestions.length === 0,
  );
export const statusLabel = (status: string) => status.replaceAll("-", " ");
export const formatNumber = (value: number) => new Intl.NumberFormat().format(value);
export const formatTokens = formatNumber;
export const formatEstimatedCost = (value: number | null) =>
  value === null ? "Pricing not configured" : `$${value.toFixed(4)} estimated cost`;

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export interface OrchestrationProgress {
  percent: number;
  stage: string;
  phase: string;
  detail: string;
  activeRole: string | null;
  elapsedMs: number;
  timeoutRemainingMs: number | null;
  lastActivityAt: string;
  heartbeatFresh: boolean;
}

export function orchestrationProgress(
  view: OrchestrationReadModel,
  nowMs: number = Date.now(),
): OrchestrationProgress | null {
  const status = view.orchestration.status;
  const lastEvent = view.events.at(-1);
  const latestEngineStage = [...view.events].reverse().find((event) =>
    ["integration-step", "verification-step"].includes(event.type),
  );
  const effectiveStatus: OrchestrationStatus =
    status === "running" && latestEngineStage
      ? latestEngineStage.type === "verification-step"
        ? "verifying"
        : "integrating"
      : status;
  const phases: Partial<Record<OrchestrationStatus, [string, string, string]>> = {
    "drafting-intent": [
      "Step 1 of 5",
      "Preparing details",
      "The planner is grounding the request in the workspace.",
    ],
    "awaiting-confirmation": [
      "Step 1 of 5",
      "Waiting for confirmation",
      "A material choice needs your answer before execution.",
    ],
    planning: [
      "Step 2 of 5",
      "Building the task and test list",
      "The planner is assigning bounded work and acceptance checks.",
    ],
    ready: ["Step 2 of 5", "Plan ready", "Execution will start automatically."],
    running: [
      "Step 4 of 5",
      "Orchestrating agents",
      "Workers are implementing and checking bounded tasks.",
    ],
    integrating: [
      "Step 5 of 5",
      "Integrating",
      "Worker outputs are being assembled into one candidate.",
    ],
    verifying: [
      "Step 5 of 5",
      "Verifying integration",
      "Trusted checks are running before publication.",
    ],
    completed: ["Step 5 of 5", "Completed", "The verified result is ready."],
    failed: ["Step 5 of 5", "Stopped", view.orchestration.error ?? "Execution failed."],
    "budget-exhausted": [
      "Step 3 of 5",
      "Budget stopped execution",
      view.orchestration.error ?? "A hard limit was reached.",
    ],
    cancelled: ["Step 4 of 5", "Cancelled", "Execution was cancelled."],
    "needs-user": ["Step 4 of 5", "Needs your input", "An agent needs a decision."],
  };
  const phase = phases[effectiveStatus];
  if (!phase) return null;

  const activeStart = [...view.events]
    .reverse()
    .filter((event) => event.type === "role-call-started")
    .find(
      (start) =>
        !view.events.some(
          (event) =>
            event.executionId === start.executionId &&
            event.createdAt >= start.createdAt &&
            ["role-call-completed", "role-call-failed"].includes(event.type),
        ),
    );
  const runningAttempt = [...view.attempts]
    .reverse()
    .find((attempt) => attempt.status === "running");
  const startedAt =
    activeStart?.createdAt ??
    runningAttempt?.createdAt ??
    lastEvent?.createdAt ??
    view.orchestration.updatedAt;
  const timeout = activeStart?.metadata.timeoutMs;
  const timeoutMs = typeof timeout === "number" ? timeout : null;
  const elapsedMs = Math.max(0, nowMs - Date.parse(startedAt));

  let percent = 5;
  if (effectiveStatus === "awaiting-confirmation") percent = 15;
  if (effectiveStatus === "planning") percent = 25;
  if (effectiveStatus === "ready") percent = 35;
  if (effectiveStatus === "running") {
    const passed = view.tasks.filter((task) => task.status === "passed").length;
    const activeCredit = view.tasks.some((task) =>
      ["preflight", "running", "verifying"].includes(task.status),
    )
      ? 0.5
      : 0;
    percent = view.tasks.length
      ? 40 + Math.round(((passed + activeCredit) / view.tasks.length) * 35)
      : 40;
  }
  if (effectiveStatus === "integrating") percent = 82;
  if (effectiveStatus === "verifying") percent = 92;
  if (effectiveStatus === "completed") percent = 100;
  if (["failed", "cancelled", "budget-exhausted"].includes(effectiveStatus)) {
    percent = Math.max(15, workflowState(view).reachedIndex * 20);
  }

  const lastHeartbeat = [...view.events].reverse().find(
    (event) =>
      event.type === "role-call-heartbeat" &&
      (!activeStart || event.executionId === activeStart.executionId),
  );
  const lastActivityAt =
    lastHeartbeat?.createdAt ?? lastEvent?.createdAt ?? view.orchestration.updatedAt;
  return {
    percent: Math.min(100, percent),
    stage: phase[0],
    phase: phase[1],
    detail: phase[2],
    activeRole: activeStart?.actorRole ?? null,
    elapsedMs,
    timeoutRemainingMs: timeoutMs === null ? null : Math.max(0, timeoutMs - elapsedMs),
    lastActivityAt,
    heartbeatFresh: nowMs - Date.parse(lastActivityAt) < 35_000,
  };
}

export type WorkflowStepId =
  | "details"
  | "planner"
  | "accounting"
  | "orchestration"
  | "integration";

export const WORKFLOW_STEPS: ReadonlyArray<{ id: WorkflowStepId; label: string }> = [
  { id: "details", label: "Details" },
  { id: "planner", label: "Planner" },
  { id: "accounting", label: "Accounting" },
  { id: "orchestration", label: "Orchestration" },
  { id: "integration", label: "Integration (Result)" },
];

export function workflowState(view: OrchestrationReadModel): {
  reachedIndex: number;
  activeIndex: number;
} {
  const { status } = view.orchestration;
  let reachedIndex = 0;
  if (
    view.plan ||
    view.tasks.length > 0 ||
    ["planning", "ready", "running", "integrating", "verifying", "completed"].includes(status)
  ) {
    reachedIndex = 1;
  }
  if (
    reachedIndex >= 1 &&
    (Object.values(view.usage.byRole).some((role) => (role?.modelCalls ?? 0) > 0) ||
      ["running", "integrating", "verifying", "completed", "budget-exhausted"].includes(status))
  ) {
    reachedIndex = 2;
  }
  if (
    reachedIndex >= 2 &&
    (view.attempts.length > 0 ||
      view.events.some((event) => event.actorRole === "worker") ||
      ["running", "integrating", "verifying", "completed"].includes(status))
  ) {
    reachedIndex = 3;
  }
  if (
    reachedIndex >= 3 &&
    (Boolean(view.orchestration.finalOutput) ||
      view.events.some((event) => /integrat|publish|global|verification-step/i.test(event.type)) ||
      ["integrating", "verifying", "completed"].includes(status))
  ) {
    reachedIndex = 4;
  }
  const activeIndex =
    status === "drafting-intent" || status === "awaiting-confirmation"
      ? 0
      : status === "planning" || status === "ready"
        ? 1
        : status === "running"
          ? 3
          : status === "integrating" || status === "verifying" || status === "completed"
            ? 4
            : reachedIndex;
  return { reachedIndex, activeIndex };
}

function option(id: string, label: string, resolutionText = label, delegate = false) {
  return { id, label, resolutionText, delegate };
}

function inferredOptions(question: string) {
  const text = question.toLowerCase();
  if (/language|typescript|javascript|python/.test(text)) {
    return [
      option("typescript", "TypeScript", "Use TypeScript."),
      option("javascript", "JavaScript", "Use JavaScript."),
      option("python", "Python", "Use Python."),
      option("delegate", "Choose for me", "Choose the best-supported language for this workspace.", true),
    ];
  }
  if (/framework|react|vue|svelte/.test(text)) {
    return [
      option("react", "React", "Use React."),
      option("vue", "Vue", "Use Vue."),
      option("svelte", "Svelte", "Use Svelte."),
      option("delegate", "Choose for me", "Choose the framework that best fits the repository.", true),
    ];
  }
  if (/platform|web|desktop|mobile/.test(text)) {
    return [
      option("web", "Web", "Target the web."),
      option("desktop", "Desktop", "Target desktop."),
      option("mobile", "Mobile", "Target mobile."),
      option("delegate", "Choose for me", "Choose the platform that best fits the request.", true),
    ];
  }
  return [
    option("recommended", "Recommended default", `Use the planner's recommended default for: ${question}`, true),
    option("minimal", "Smallest scope", `Choose the smallest safe scope for: ${question}`),
  ];
}

export function toClarificationQuestion(
  rawQuestion: string,
  index: number,
): ClarificationQuestionView {
  try {
    const parsed = JSON.parse(rawQuestion) as {
      prompt?: unknown;
      consequenceIfWrong?: unknown;
      options?: Array<{ label?: unknown; resolutionText?: unknown; delegate?: unknown }>;
    };
    if (
      typeof parsed.prompt === "string" &&
      Array.isArray(parsed.options) &&
      parsed.options.length > 0
    ) {
      const options = parsed.options
        .filter(
          (item) =>
            typeof item.label === "string" && typeof item.resolutionText === "string",
        )
        .map((item, optionIndex) =>
          option(
            `q${index}-o${optionIndex}`,
            item.label as string,
            item.resolutionText as string,
            item.delegate === true,
          ),
        );
      if (options.length) {
        return {
          id: `question-${index}`,
          prompt: parsed.prompt,
          consequenceIfWrong:
            typeof parsed.consequenceIfWrong === "string"
              ? parsed.consequenceIfWrong
              : "This choice materially changes the implementation.",
          options,
          rawQuestion,
        };
      }
    }
  } catch {
    // Older orchestrations contain plain questions; deterministic fallbacks keep them answerable.
  }
  return {
    id: `question-${index}`,
    prompt: rawQuestion,
    consequenceIfWrong: "This choice materially changes scope or implementation.",
    options: inferredOptions(rawQuestion),
    rawQuestion,
  };
}

export type EventFilterKey =
  | "all"
  | "task"
  | "role"
  | "failure"
  | "budget"
  | "verification"
  | "integration";

export const EVENT_FILTERS: ReadonlyArray<{ key: EventFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "task", label: "Tasks" },
  { key: "role", label: "Roles" },
  { key: "failure", label: "Failures" },
  { key: "budget", label: "Budget" },
  { key: "verification", label: "Verification" },
  { key: "integration", label: "Integration" },
];

const FILTER_PATTERNS: Record<Exclude<EventFilterKey, "all">, RegExp> = {
  task: /task|preflight|attempt|context|stale|refresh/i,
  role: /planner|worker|verifier|integrator|model|route|plan/i,
  failure: /fail|error|escalat|denied|cancel|abort|budget-exhausted/i,
  budget: /budget|usage|token|cost|reservation|limit/i,
  verification: /verif|check|acceptance|protected|global/i,
  integration: /integrat|merge|publish|conflict|reconcil/i,
};

export function eventMatchesFilter(event: OrchestrationEvent, filter: EventFilterKey) {
  if (filter === "all") return true;
  if (filter === "role" && event.actorRole !== "user" && event.actorRole !== "control-plane") {
    return true;
  }
  if (filter === "task" && event.taskId) return true;
  const pattern = FILTER_PATTERNS[filter];
  return pattern.test(event.type) || pattern.test(event.summary);
}

export function filterEvents(
  events: OrchestrationEvent[],
  filter: EventFilterKey | ActorRole,
  taskId?: string | null,
): OrchestrationEvent[] {
  return events.filter((event) => {
    if (taskId && event.taskId !== taskId) return false;
    if (filter === "all") return true;
    if (
      ["user", "planner", "worker", "verifier", "integrator", "control-plane", "runtime"].includes(filter)
    ) {
      return event.actorRole === filter;
    }
    return eventMatchesFilter(event, filter as EventFilterKey);
  });
}

export type StatusTone = "pending" | "active" | "success" | "warning" | "danger";
export interface StatusPresentation {
  label: string;
  icon: string;
  tone: StatusTone;
}

export function eventTone(event: OrchestrationEvent): StatusTone {
  const text = `${event.type} ${event.summary}`;
  if (/fail|error|denied|exhaust/i.test(text)) return "danger";
  if (/cancel|stale|needs-user|escalat|warn/i.test(text)) return "warning";
  if (/complete|passed|publish|verified|confirm/i.test(text)) return "success";
  return "pending";
}

const TASK_STATUS: Record<OrchestrationTaskStatus, StatusPresentation> = {
  blocked: { label: "Blocked", icon: "▢", tone: "pending" },
  ready: { label: "Ready", icon: "▷", tone: "pending" },
  preflight: { label: "Preflight", icon: "◐", tone: "active" },
  running: { label: "Running", icon: "◌", tone: "active" },
  verifying: { label: "Verifying", icon: "◍", tone: "active" },
  stale: { label: "Stale", icon: "⟳", tone: "warning" },
  passed: { label: "Passed", icon: "✓", tone: "success" },
  failed: { label: "Failed", icon: "✕", tone: "danger" },
  cancelled: { label: "Cancelled", icon: "⊘", tone: "warning" },
};
export const taskStatusPresentation = (status: OrchestrationTaskStatus) =>
  TASK_STATUS[status];

const MODEL_ROLES: ModelRole[] = ["planner", "worker", "verifier", "integrator"];
export const PRICING_NOT_CONFIGURED = "Pricing not configured";

export function summarizeUsage(usage: UsageLedger) {
  const rows = MODEL_ROLES.flatMap((role) => {
    const entry = usage.byRole[role];
    return entry
      ? [{ role, ...entry, estimatedUsd: usage.pricingStatus === "configured" ? entry.estimatedUsd : null }]
      : [];
  });
  return {
    rows,
    totalInputTokens: usage.totalInputTokens,
    totalCachedInputTokens: usage.totalCachedInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalModelCalls: rows.reduce((total, row) => total + row.modelCalls, 0),
    totalEstimatedUsd:
      usage.pricingStatus === "configured" ? usage.totalEstimatedUsd : null,
  };
}

export function budgetGauges(
  usage: UsageLedger,
  budget: BudgetPolicy,
  modelCalls: number,
  elapsedMs: number,
) {
  const gauge = (label: string, used: number, limit: number | null, suffix = "") => ({
    label,
    ratio: limit && limit > 0 ? Math.min(1, used / limit) : null,
    exceeded: limit != null && limit > 0 && used >= limit,
    display:
      limit == null || limit === 0
        ? `${formatNumber(used)}${suffix} used · no hard limit`
        : `${formatNumber(used)}${suffix} / ${formatNumber(limit)}${suffix}`,
  });
  const gauges = [
    gauge("Input tokens", usage.totalInputTokens, budget.maxInputTokens),
    gauge("Output tokens", usage.totalOutputTokens, budget.maxOutputTokens),
    gauge("Model calls", modelCalls, budget.maxModelCalls || null),
    gauge(
      "Wall clock",
      Math.round(elapsedMs / 1_000),
      Math.round(budget.maxWallClockMs / 1_000) || null,
      "s",
    ),
  ];
  if (usage.pricingStatus === "configured" && budget.maxEstimatedUsd != null) {
    gauges.push({
      label: "Estimated cost",
      ratio: Math.min(1, (usage.totalEstimatedUsd ?? 0) / budget.maxEstimatedUsd),
      exceeded: (usage.totalEstimatedUsd ?? 0) >= budget.maxEstimatedUsd,
      display: `$${(usage.totalEstimatedUsd ?? 0).toFixed(4)} / $${budget.maxEstimatedUsd.toFixed(2)}`,
    });
  }
  return gauges;
}

export function compareEstimateToActual(
  estimate: CostEstimate | null,
  usage: UsageLedger,
) {
  if (!estimate) return null;
  const low = estimate.inputTokenLow + estimate.outputTokenLow;
  const high = estimate.inputTokenHigh + estimate.outputTokenHigh;
  const actualTokens = usage.totalInputTokens + usage.totalOutputTokens;
  return {
    tokenRange: `${formatNumber(low)} – ${formatNumber(high)} tokens`,
    costRange:
      estimate.pricingStatus === "configured" &&
      estimate.estimatedUsdLow != null &&
      estimate.estimatedUsdHigh != null
        ? `estimated cost $${estimate.estimatedUsdLow.toFixed(4)} – $${estimate.estimatedUsdHigh.toFixed(4)}`
        : PRICING_NOT_CONFIGURED,
    actualTokens,
    actualCost:
      usage.pricingStatus === "configured" && usage.totalEstimatedUsd != null
        ? `estimated cost $${usage.totalEstimatedUsd.toFixed(4)}`
        : PRICING_NOT_CONFIGURED,
    overHighEstimate: high > 0 && actualTokens > high,
  };
}

export interface EvidenceCounters {
  tasks: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
  verifications: number;
  failedVerifications: number;
  artifacts: number;
  staleRefreshes: number;
}

export function evidenceCounters(view: OrchestrationReadModel): EvidenceCounters {
  const countEvents = (pattern: RegExp) =>
    view.events.filter((event) => pattern.test(event.type)).length;
  return {
    tasks: view.tasks.length,
    attempts: view.attempts.length,
    contextExpansions: countEvents(/context[-_.]?expansion/i),
    escalations: countEvents(/escalat/i),
    integrationFailures: countEvents(/integration[-_.]?fail/i),
    verifications: view.verifications.length,
    failedVerifications: view.verifications.filter((item) => item.status === "failed").length,
    artifacts: view.artifacts.length,
    staleRefreshes: countEvents(/stale|refresh/i),
  };
}

export function elapsedMsFor(view: OrchestrationReadModel, nowMs: number): number {
  const started = Date.parse(view.orchestration.createdAt);
  const finished = view.orchestration.completedAt
    ? Date.parse(view.orchestration.completedAt)
    : nowMs;
  return Math.max(0, (Number.isNaN(finished) ? nowMs : finished) - started);
}

export function budgetStopReason(view: OrchestrationReadModel): string | null {
  if (view.orchestration.status !== "budget-exhausted") return null;
  const event = view.events.find((item) => /budget/i.test(item.type));
  return event?.summary ?? view.orchestration.error ?? "The hard budget was reached.";
}

export type ChatTimelineEntry =
  | { kind: "message"; message: Message; at: string }
  | { kind: "orchestration-summary"; summary: OrchestrationSummary; at: string };

export function buildChatTimeline(
  messages: Message[],
  pastOrchestrations: OrchestrationSummary[],
): ChatTimelineEntry[] {
  const entries: ChatTimelineEntry[] = [
    ...messages.map((message) => ({ kind: "message" as const, message, at: message.createdAt })),
    ...pastOrchestrations.map((summary) => ({
      kind: "orchestration-summary" as const,
      summary,
      at: summary.createdAt,
    })),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

export function safeReadModel(value: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...value,
    events: value.events.map(
      ({ id, taskId, executionId, type, actorRole, modelId, summary, metadata, createdAt }) => ({
        id,
        taskId,
        executionId,
        type,
        actorRole,
        modelId,
        summary,
        metadata,
        createdAt,
      }),
    ),
    contextPackets: value.contextPackets.map((packet) => ({
      ...packet,
      sourceFiles: packet.sourceFiles.map(({ path, sha256, bytes }) => ({
        path,
        sha256,
        bytes,
      })),
    })),
  };
}
