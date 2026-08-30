import type {
  BenchmarkRecord,
  IntentClaim,
  IntentDraft,
  IntentProvenance,
  Orchestration,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationStatus,
  RequestedExecutionMode,
  UsageLedger,
} from "./contracts";

export type PlaygroundMode = "direct" | "auto" | "orchestrated";

/** Mode-to-action mapping: what backend request each Playground mode issues. */
export function modeToRequestedMode(mode: PlaygroundMode): RequestedExecutionMode {
  if (mode === "direct") return "direct";
  if (mode === "orchestrated") return "orchestrated";
  return "auto";
}

export const TERMINAL_STATUSES: ReadonlySet<OrchestrationStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

export function isTerminalStatus(status: OrchestrationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface StatusDescription {
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
}

const STATUS_DESCRIPTIONS: Record<OrchestrationStatus, StatusDescription> = {
  "drafting-intent": { label: "Drafting intent", tone: "info" },
  "awaiting-confirmation": { label: "Awaiting your confirmation", tone: "warning" },
  planning: { label: "Confirmed — planning", tone: "info" },
  ready: { label: "Ready to run", tone: "info" },
  running: { label: "Running", tone: "info" },
  integrating: { label: "Integrating changes", tone: "info" },
  verifying: { label: "Verifying", tone: "info" },
  "needs-user": { label: "Needs your input", tone: "warning" },
  "budget-exhausted": { label: "Budget exhausted", tone: "danger" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function describeStatus(status: OrchestrationStatus): StatusDescription {
  return STATUS_DESCRIPTIONS[status] ?? { label: status, tone: "neutral" };
}

export interface ConfirmationGate {
  allowed: boolean;
  reason: string | null;
}

/**
 * Mirrors the server's own confirmation gate (never trust the UI's copy as
 * authoritative — the server re-checks this on every confirm call) so the
 * Confirm button can be disabled *before* a round trip, with the same
 * reasoning a rejected request would give.
 */
export function evaluateConfirmationGate(readModel: OrchestrationReadModel): ConfirmationGate {
  const draft = readModel.currentDraft;
  if (!draft) {
    return { allowed: false, reason: "No intent draft is available yet." };
  }
  if (draft.openQuestions.length > 0) {
    return {
      allowed: false,
      reason: `${draft.openQuestions.length} material question${draft.openQuestions.length === 1 ? "" : "s"} must be answered first.`,
    };
  }
  if (readModel.orchestration.status !== "awaiting-confirmation") {
    return { allowed: false, reason: `Cannot confirm while the orchestration is "${readModel.orchestration.status}".` };
  }
  return { allowed: true, reason: null };
}

export interface ClaimsByProvenance {
  userExplicit: IntentClaim[];
  plannerInferred: IntentClaim[];
  repositoryDerived: IntentClaim[];
  userDelegated: IntentClaim[];
}

function emptyGroups(): ClaimsByProvenance {
  return { userExplicit: [], plannerInferred: [], repositoryDerived: [], userDelegated: [] };
}

const PROVENANCE_KEY: Record<IntentProvenance, keyof ClaimsByProvenance> = {
  "user-explicit": "userExplicit",
  "planner-inferred": "plannerInferred",
  "repository-derived": "repositoryDerived",
  "user-delegated": "userDelegated",
};

/** Groups every claim across all five categories of a draft by provenance — the UI never collapses this distinction. */
export function groupClaimsByProvenance(draft: IntentDraft): ClaimsByProvenance {
  const groups = emptyGroups();
  const all = [
    ...draft.requirements,
    ...draft.assumptions,
    ...draft.nonGoals,
    ...draft.architectureDecisions,
    ...draft.manualExpectations,
  ];
  for (const claim of all) {
    groups[PROVENANCE_KEY[claim.provenance]].push(claim);
  }
  return groups;
}

export const PROVENANCE_LABEL: Record<IntentProvenance, string> = {
  "user-explicit": "You said",
  "planner-inferred": "Planner inferred",
  "repository-derived": "From the repository",
  "user-delegated": "You delegated to the planner",
};

export interface UsageDisplay {
  tokensLabel: string;
  costLabel: string;
  pricingConfigured: boolean;
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

/** Never says "billed cost" — this is always an estimate, and an honest "Pricing not configured" when unknown. */
export function formatUsage(usage: UsageLedger): UsageDisplay {
  const tokensLabel = `${formatTokenCount(usage.totalInputTokens)} in / ${formatTokenCount(usage.totalCachedInputTokens)} cached / ${formatTokenCount(usage.totalOutputTokens)} out`;
  if (usage.pricingStatus === "unknown" || usage.totalEstimatedUsd === null) {
    return { tokensLabel, costLabel: "Pricing not configured", pricingConfigured: false };
  }
  return {
    tokensLabel,
    costLabel: `estimated cost $${usage.totalEstimatedUsd.toFixed(4)}`,
    pricingConfigured: true,
  };
}

export function formatEstimateRange(orchestration: Orchestration): string {
  const estimate = orchestration.estimate;
  if (!estimate) return "No estimate yet";
  const tokenRange = `${formatTokenCount(estimate.inputTokenLow)}–${formatTokenCount(estimate.inputTokenHigh)} in, ${formatTokenCount(estimate.outputTokenLow)}–${formatTokenCount(estimate.outputTokenHigh)} out`;
  if (estimate.pricingStatus === "unknown" || estimate.estimatedUsdLow === null || estimate.estimatedUsdHigh === null) {
    return `${tokenRange} tokens — pricing not configured`;
  }
  return `${tokenRange} tokens — estimated $${estimate.estimatedUsdLow.toFixed(2)}–$${estimate.estimatedUsdHigh.toFixed(2)}`;
}

export interface EventFilter {
  taskId?: string;
  actorRole?: string;
  type?: string;
}

export function filterEvents(events: OrchestrationEvent[], filter: EventFilter): OrchestrationEvent[] {
  return events.filter((event) => {
    if (filter.taskId && event.taskId !== filter.taskId) return false;
    if (filter.actorRole && event.actorRole !== filter.actorRole) return false;
    if (filter.type && event.type !== filter.type) return false;
    return true;
  });
}

/**
 * Curated, safe rendering fields for one event — deliberately does NOT
 * spread the raw event object into the DOM. `metadata` values are
 * stringified defensively rather than rendered as objects, so an
 * unexpected shape can never leak structured/unsafe content through.
 */
export interface SafeEventView {
  id: string;
  type: string;
  actorRole: string;
  summary: string;
  createdAt: string;
  metadataEntries: Array<[string, string]>;
}

export function toSafeEventView(event: OrchestrationEvent): SafeEventView {
  const metadataEntries = Object.entries(event.metadata ?? {}).map(
    ([key, value]) => [key, String(value)] as [string, string],
  );
  return {
    id: event.id,
    type: event.type,
    actorRole: event.actorRole,
    summary: String(event.summary ?? ""),
    createdAt: event.createdAt,
    metadataEntries,
  };
}

/**
 * Defensive parsing for a raw `Orchestration` payload: returns `null`
 * instead of throwing or rendering a half-formed object when required
 * fields are missing or the wrong type — the caller decides how to show
 * "unavailable" rather than crashing the panel on a malformed/future server
 * response shape.
 */
export function safeOrchestration(raw: unknown): Orchestration | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<Orchestration>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.prompt !== "string"
  ) {
    return null;
  }
  return candidate as Orchestration;
}

export interface BenchmarkInterpretation {
  verdict: string;
  safeToCompareCost: boolean;
}

/**
 * Client-side mirror of the server's `interpretBenchmark` (see
 * apps/server/src/orchestration/benchmark/service.ts) — kept as a small,
 * intentional duplication since the web and server workspaces don't share
 * types at build time. Never implies a cost "winner" when the two arms
 * didn't produce comparable quality.
 */
export function interpretBenchmarkResult(record: BenchmarkRecord): BenchmarkInterpretation {
  if (!record.direct || !record.orchestrated) {
    return { verdict: "Benchmark is still running or incomplete.", safeToCompareCost: false };
  }
  if (record.direct.success !== record.orchestrated.success) {
    const winner = record.direct.success ? "direct" : "orchestrated";
    return {
      verdict: `Only the ${winner} arm passed verification — quality, not cost, decides this comparison.`,
      safeToCompareCost: false,
    };
  }
  if (!record.direct.success && !record.orchestrated.success) {
    return { verdict: "Neither arm passed verification.", safeToCompareCost: false };
  }
  if (record.direct.pricingStatus === "unknown" || record.orchestrated.pricingStatus === "unknown") {
    return {
      verdict: "Both arms passed verification; dollar cost is unknown for at least one arm, so only token totals are comparable.",
      safeToCompareCost: false,
    };
  }
  const directUsd = record.direct.estimatedUsd ?? 0;
  const orchestratedUsd = record.orchestrated.estimatedUsd ?? 0;
  const cheaper = directUsd <= orchestratedUsd ? "direct" : "orchestrated";
  return {
    verdict: `Both arms passed verification with comparable quality; ${cheaper} was cheaper by estimated cost.`,
    safeToCompareCost: true,
  };
}
