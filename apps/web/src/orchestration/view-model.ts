import type {
  ApplicationMapSummary,
  BenchmarkArm,
  BenchmarkArmResult,
  BenchmarkComparison,
  BenchmarkRecord,
  BudgetPolicy,
  BudgetStatus,
  ContextPacketSummary,
  ContractAmendment,
  ContractCriterion,
  CostEstimate,
  ExecutionContract,
  FailurePacket,
  IntentDraft,
  ModelRole,
  Orchestration,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationStatus,
  OrchestrationSummary,
  OrchestrationTask,
  OrchestrationTaskStatus,
  PlanSummary,
  RequestedExecutionMode,
  RoleUsage,
  SharedArtifact,
  TokenUsage,
  UsageLedger,
  VerificationRecord,
  WorkerAttempt,
  WorkspaceDisposition,
} from "./contracts";
import {
  MODEL_ROLES,
  ORCHESTRATION_STATUSES,
  TASK_STATUSES,
  TERMINAL_BENCHMARK_STATUSES,
  TERMINAL_ORCHESTRATION_STATUSES,
} from "./contracts";

/**
 * The single conversion layer between untrusted server JSON and the React tree.
 *
 * Three jobs, all pure and unit-testable:
 *   1. narrow `unknown` into the DTOs without scattering casts through the UI;
 *   2. drop or bound anything unsafe to render (chain-of-thought, protected
 *      evaluator source, secrets, giant payloads, raw filesystem paths);
 *   3. derive the small pieces of state the components need (confirmation
 *      gating, filters, usage totals, budget progress, benchmark ordering).
 */

/* -------------------------------------------------------------------------- */
/* Safety                                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_RENDERED_TEXT = 4_000;
export const MAX_RENDERED_LIST = 200;
export const MAX_PAYLOAD_PREVIEW = 1_500;

/**
 * Fields the UI refuses to render even if a server ever sends them. These are
 * dropped during normalization, so no component can accidentally print them.
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "reasoning",
  "chainofthought",
  "chain_of_thought",
  "thinking",
  "protectedsource",
  "protected_source",
  "evaluatorsource",
  "evaluator_source",
  "protectedtestsource",
  "sourcecontent",
  "filecontents",
  "rawoutput",
  "env",
  "environment",
  "apikey",
  "api_key",
  "arkapikey",
  "ark_api_key",
  "authorization",
  "authtoken",
  "auth_token",
  "bearertoken",
  "cookie",
  "password",
  "secret",
  "token",
];

const SECRET_ASSIGNMENT =
  /((?:ark[_-]?api[_-]?key|api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|secret|password|passwd|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?\S+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9._-]{12,}\b/gi;

export function isForbiddenField(key: string): boolean {
  return FORBIDDEN_FIELDS.includes(key.toLowerCase().replace(/[^a-z_]/g, ""));
}

/**
 * Defence in depth. The control plane redacts before persistence; this is the
 * last stop before the DOM, so it repeats the scrub and bounds the length.
 */
export function safeText(value: unknown, limit = MAX_RENDERED_TEXT): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  const scrubbed = raw
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(OPENAI_STYLE_KEY, "[redacted]");
  return scrubbed.length > limit ? scrubbed.slice(0, limit) + "…" : scrubbed;
}

/** A workspace path is shown as its final segments only, never a host root. */
export function safePath(value: unknown): string {
  const text = safeText(value, 400).replace(/\\/g, "/");
  const segments = text.split("/").filter(Boolean);
  if (segments.length <= 3) return segments.join("/");
  return "…/" + segments.slice(-3).join("/");
}

function stringList(value: unknown, limit = MAX_RENDERED_LIST): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => safeText(item, 600)).filter(Boolean);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function iso(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* -------------------------------------------------------------------------- */
/* Normalizers                                                                */
/* -------------------------------------------------------------------------- */

export function normalizeTokenUsage(value: unknown): TokenUsage {
  const raw = record(value);
  return {
    inputTokens: num(raw.inputTokens),
    cachedInputTokens: num(raw.cachedInputTokens),
    outputTokens: num(raw.outputTokens),
  };
}

export function normalizeUsageLedger(value: unknown): UsageLedger {
  const raw = record(value);
  const byRoleRaw = record(raw.byRole);
  const byRole: Partial<Record<ModelRole, RoleUsage>> = {};
  for (const role of MODEL_ROLES) {
    const entry = byRoleRaw[role];
    if (!entry) continue;
    const parsed = record(entry);
    byRole[role] = {
      modelId: safeText(parsed.modelId, 200) || "unknown",
      inputTokens: num(parsed.inputTokens),
      cachedInputTokens: num(parsed.cachedInputTokens),
      outputTokens: num(parsed.outputTokens),
      estimatedUsd: nullableNum(parsed.estimatedUsd),
      modelCalls: num(parsed.modelCalls),
    };
  }
  const pricingStatus = raw.pricingStatus === "configured" ? "configured" : "unknown";
  return {
    byRole,
    totalInputTokens: num(raw.totalInputTokens),
    totalCachedInputTokens: num(raw.totalCachedInputTokens),
    totalOutputTokens: num(raw.totalOutputTokens),
    // Never surface a dollar figure when pricing is not configured.
    totalEstimatedUsd:
      pricingStatus === "configured" ? nullableNum(raw.totalEstimatedUsd) : null,
    pricingStatus,
  };
}

export const DEFAULT_BUDGET: BudgetPolicy = {
  maxInputTokens: null,
  maxOutputTokens: null,
  maxEstimatedUsd: null,
  maxModelCalls: 0,
  maxSteps: 0,
  maxWorkerAttempts: 0,
  maxContextExpansionsPerTask: 0,
  maxWallClockMs: 0,
};

export function normalizeBudget(value: unknown): BudgetPolicy {
  const raw = record(value);
  return {
    maxInputTokens: nullableNum(raw.maxInputTokens),
    maxOutputTokens: nullableNum(raw.maxOutputTokens),
    maxEstimatedUsd: nullableNum(raw.maxEstimatedUsd),
    maxModelCalls: num(raw.maxModelCalls),
    maxSteps: num(raw.maxSteps),
    maxWorkerAttempts: num(raw.maxWorkerAttempts),
    maxContextExpansionsPerTask: num(raw.maxContextExpansionsPerTask),
    maxWallClockMs: num(raw.maxWallClockMs),
  };
}

export function normalizeEstimate(value: unknown): CostEstimate | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  const pricingStatus = raw.pricingStatus === "configured" ? "configured" : "unknown";
  return {
    inputTokenLow: num(raw.inputTokenLow),
    inputTokenHigh: num(raw.inputTokenHigh),
    outputTokenLow: num(raw.outputTokenLow),
    outputTokenHigh: num(raw.outputTokenHigh),
    estimatedUsdLow: pricingStatus === "configured" ? nullableNum(raw.estimatedUsdLow) : null,
    estimatedUsdHigh:
      pricingStatus === "configured" ? nullableNum(raw.estimatedUsdHigh) : null,
    pricingStatus,
    assumptions: stringList(raw.assumptions, 30),
  };
}

export function normalizeIntentDraft(value: unknown): IntentDraft | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    revision: num(raw.revision, 1),
    goal: safeText(raw.goal),
    requirements: stringList(raw.requirements, 60),
    assumptions: stringList(raw.assumptions, 60),
    nonGoals: stringList(raw.nonGoals, 60),
    architectureDecisions: stringList(raw.architectureDecisions, 60),
    materialQuestions: stringList(raw.materialQuestions, 30),
    manualExpectations: stringList(raw.manualExpectations, 30),
    createdAt: iso(raw.createdAt),
  };
}

const CRITERION_KINDS = [
  "functional",
  "architectural",
  "scope",
  "runtime",
  "manual",
] as const;
const CRITERION_VERIFICATIONS = [
  "visible-test",
  "protected-test",
  "static-check",
  "manual",
] as const;

export function normalizeCriteria(value: unknown): ContractCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    const raw = record(item);
    return {
      id: safeText(raw.id, 120),
      kind: oneOf(raw.kind, CRITERION_KINDS, "functional"),
      description: safeText(raw.description, 1_000),
      // Criterion descriptions are safe to show; protected implementations are
      // never sent by the control plane and are dropped here if they ever are.
      verification: oneOf(raw.verification, CRITERION_VERIFICATIONS, "manual"),
    };
  });
}

export function normalizeContract(value: unknown): ExecutionContract | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  const intent = normalizeIntentDraft(raw.intent);
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    version: num(raw.version, 1),
    intent: intent ?? emptyIntent(safeText(raw.orchestrationId, 100)),
    criteria: normalizeCriteria(raw.criteria),
    confirmedBy: "user",
    confirmedAt: iso(raw.confirmedAt),
    supersedesContractId:
      typeof raw.supersedesContractId === "string" ? raw.supersedesContractId : null,
  };
}

function emptyIntent(orchestrationId: string): IntentDraft {
  return {
    id: "",
    orchestrationId,
    revision: 0,
    goal: "",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    materialQuestions: [],
    manualExpectations: [],
    createdAt: "",
  };
}

export function normalizeAmendment(value: unknown): ContractAmendment | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  const proposed = normalizeIntentDraft(raw.proposedIntent);
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    baseContractId: safeText(raw.baseContractId, 100),
    proposedIntent: proposed ?? emptyIntent(safeText(raw.orchestrationId, 100)),
    proposedCriteria: Array.isArray(raw.proposedCriteria)
      ? normalizeCriteria(raw.proposedCriteria)
      : null,
    reason: safeText(raw.reason, 2_000),
    material: bool(raw.material),
    status: oneOf(raw.status, ["pending", "confirmed", "rejected"] as const, "pending"),
    createdAt: iso(raw.createdAt),
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
  };
}

const REQUESTED_MODES = ["auto", "direct", "orchestrated"] as const;
const SELECTED_MODES = ["direct", "one-worker", "multi-worker"] as const;

export function normalizeOrchestration(value: unknown): Orchestration | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    agentId: safeText(raw.agentId, 100),
    prompt: safeText(raw.prompt, MAX_RENDERED_TEXT),
    requestedMode: oneOf(raw.requestedMode, REQUESTED_MODES, "auto"),
    selectedMode:
      typeof raw.selectedMode === "string" &&
      (SELECTED_MODES as readonly string[]).includes(raw.selectedMode)
        ? (raw.selectedMode as Orchestration["selectedMode"])
        : null,
    status: oneOf(raw.status, ORCHESTRATION_STATUSES, "drafting-intent"),
    currentIntentDraftId:
      typeof raw.currentIntentDraftId === "string" ? raw.currentIntentDraftId : null,
    activeContractId:
      typeof raw.activeContractId === "string" ? raw.activeContractId : null,
    estimate: normalizeEstimate(raw.estimate),
    budget: normalizeBudget(raw.budget),
    usage: normalizeUsageLedger(raw.usage),
    finalOutput: raw.finalOutput == null ? null : safeText(raw.finalOutput, 20_000),
    error: raw.error == null ? null : safeText(raw.error, 2_000),
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt),
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
  };
}

export function normalizeTask(value: unknown): OrchestrationTask | null {
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  const observed = record(raw.observedArtifactVersions);
  const observedArtifactVersions: Record<string, number> = {};
  for (const [key, version] of Object.entries(observed).slice(0, 50)) {
    observedArtifactVersions[safeText(key, 120)] = num(version);
  }
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    title: safeText(raw.title, 300),
    objective: safeText(raw.objective, 1_500),
    status: oneOf(raw.status, TASK_STATUSES, "blocked"),
    dependsOn: stringList(raw.dependsOn, 30),
    allowedPaths: Array.isArray(raw.allowedPaths)
      ? raw.allowedPaths.slice(0, 50).map((item) => safePath(item))
      : [],
    acceptanceCriterionIds: stringList(raw.acceptanceCriterionIds, 50),
    requiredArtifactIds: stringList(raw.requiredArtifactIds, 50),
    observedArtifactVersions,
    applicationMapVersion: num(raw.applicationMapVersion),
    attemptCount: num(raw.attemptCount),
  };
}

const EVENT_ACTORS = [
  "user",
  "planner",
  "worker",
  "verifier",
  "integrator",
  "control-plane",
  "runtime",
] as const;

export function normalizeEvent(value: unknown): OrchestrationEvent | null {
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  const metadataRaw = record(raw.metadata);
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(metadataRaw).slice(0, 40)) {
    // Unknown metadata is allowed through, but forbidden keys never are.
    if (isForbiddenField(key)) continue;
    if (entry === null) metadata[key] = null;
    else if (typeof entry === "number") metadata[key] = num(entry);
    else if (typeof entry === "boolean") metadata[key] = entry;
    else if (typeof entry === "string") metadata[key] = safeText(entry, 400);
  }
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    executionId: typeof raw.executionId === "string" ? raw.executionId : null,
    type: safeText(raw.type, 120) || "event",
    actorRole: oneOf(raw.actorRole, EVENT_ACTORS, "control-plane"),
    modelId: typeof raw.modelId === "string" ? safeText(raw.modelId, 200) : null,
    summary: safeText(raw.summary, 1_500),
    metadata,
    createdAt: iso(raw.createdAt),
  };
}

export function normalizeArtifact(value: unknown): SharedArtifact | null {
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    producerTaskId: safeText(raw.producerTaskId, 100),
    kind: oneOf(
      raw.kind,
      ["api", "interface", "schema", "decision", "manifest", "test-result"] as const,
      "decision",
    ),
    name: safeText(raw.name, 200),
    version: num(raw.version, 1),
    payload: safeText(raw.payload, MAX_PAYLOAD_PREVIEW),
    createdAt: iso(raw.createdAt),
  };
}

export function normalizeAttempt(value: unknown): WorkerAttempt | null {
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    taskId: safeText(raw.taskId, 100),
    number: num(raw.number, 1),
    executionId: safeText(raw.executionId, 120),
    modelId: safeText(raw.modelId, 200),
    contextFileHashes: stringList(raw.contextFileHashes, 100),
    changedFiles: Array.isArray(raw.changedFiles)
      ? raw.changedFiles.slice(0, 100).map((item) => safePath(item))
      : [],
    status: oneOf(
      raw.status,
      ["running", "passed", "failed", "cancelled"] as const,
      "running",
    ),
    usage: normalizeTokenUsage(raw.usage),
    errorSummary: raw.errorSummary == null ? null : safeText(raw.errorSummary, 1_500),
    createdAt: iso(raw.createdAt),
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
  };
}

export function normalizeVerification(value: unknown): VerificationRecord | null {
  const raw = record(value);
  if (typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    orchestrationId: safeText(raw.orchestrationId, 100),
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    scope: oneOf(
      raw.scope,
      ["worker-visible", "protected", "global", "manual"] as const,
      "global",
    ),
    // Only the check's label is rendered. Protected evaluator source is never
    // requested and would be dropped by `safeText`'s bound in any case.
    commandOrCheck: safeText(raw.commandOrCheck, 300),
    status: oneOf(raw.status, ["passed", "failed", "skipped"] as const, "skipped"),
    outputSummary: safeText(raw.outputSummary, 2_000),
    startedAt: iso(raw.startedAt),
    completedAt: iso(raw.completedAt),
  };
}

export function normalizeContextPacket(value: unknown): ContextPacketSummary | null {
  const raw = record(value);
  if (typeof raw.taskId !== "string") return null;
  const artifactVersionsRaw = record(raw.artifactVersions);
  const artifactVersions: Record<string, number> = {};
  for (const [key, version] of Object.entries(artifactVersionsRaw).slice(0, 50)) {
    artifactVersions[safeText(key, 120)] = num(version);
  }
  return {
    taskId: raw.taskId,
    applicationMapVersion: num(raw.applicationMapVersion),
    contractVersion: num(raw.contractVersion),
    sourceFiles: Array.isArray(raw.sourceFiles)
      ? raw.sourceFiles.slice(0, 100).map((item) => {
          const file = record(item);
          return {
            path: safePath(file.path),
            sha256: safeText(file.sha256, 64),
            bytes: num(file.bytes),
          };
        })
      : [],
    relevantInterfaces: stringList(raw.relevantInterfaces, 50),
    artifactVersions,
    estimatedTokens: num(raw.estimatedTokens),
  };
}

export function normalizeFailurePacket(value: unknown): FailurePacket | null {
  const raw = record(value);
  if (typeof raw.taskId !== "string") return null;
  return {
    taskId: raw.taskId,
    contractVersion: num(raw.contractVersion),
    attemptCount: num(raw.attemptCount),
    lastError: safeText(raw.lastError, 1_500),
    failingChecks: stringList(raw.failingChecks, 30),
    changedFiles: Array.isArray(raw.changedFiles)
      ? raw.changedFiles.slice(0, 100).map((item) => safePath(item))
      : [],
    diffSummary: safeText(raw.diffSummary, 2_000),
    relevantInterfaces: stringList(raw.relevantInterfaces, 30),
    workerDiagnosis: safeText(raw.workerDiagnosis, 2_000),
    usage: normalizeTokenUsage(raw.usage),
  };
}

export function normalizeApplicationMap(value: unknown): ApplicationMapSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  return {
    orchestrationId: safeText(raw.orchestrationId, 100),
    version: num(raw.version),
    repositoryHash: safeText(raw.repositoryHash, 64),
    summary: safeText(raw.summary, 2_000),
    fileCount: num(raw.fileCount),
    createdAt: iso(raw.createdAt),
  };
}

/**
 * Task 1's `PlanView` carries an `applicationMapVersion` plus a separate
 * `applicationMaps` collection rather than an inline map, so the version is
 * resolved against that collection here. An inline `applicationMap` is still
 * accepted, so either shape renders.
 */
export function normalizePlan(
  value: unknown,
  applicationMaps: ApplicationMapSummary[] = [],
): PlanSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  if (typeof raw.selectedMode !== "string") return null;
  const applicationMapVersion = num(raw.applicationMapVersion);
  const inlineMap = normalizeApplicationMap(raw.applicationMap);
  const resolvedMap =
    inlineMap ??
    applicationMaps.find((map) => map.version === applicationMapVersion) ??
    applicationMaps[applicationMaps.length - 1] ??
    null;
  return {
    selectedMode: oneOf(raw.selectedMode, SELECTED_MODES, "direct"),
    routeReason: safeText(raw.routeReason, 1_500),
    applicationMapVersion: applicationMapVersion || (resolvedMap?.version ?? 0),
    taskIds: stringList(raw.taskIds, 50),
    applicationMap: resolvedMap,
  };
}

const DISPOSITION_POLICIES = [
  "cleaned",
  "archived",
  "retained-for-debugging",
  "unknown",
] as const;

export function normalizeWorkspaceDisposition(
  value: unknown,
): WorkspaceDisposition | null {
  const raw = record(value);
  if (typeof raw.orchestrationId !== "string") return null;
  return {
    orchestrationId: safeText(raw.orchestrationId, 100),
    taskId: typeof raw.taskId === "string" ? raw.taskId : null,
    policy: oneOf(raw.policy, DISPOSITION_POLICIES, "unknown"),
    location: raw.location == null ? null : safePath(raw.location),
    reason: safeText(raw.reason, 500),
    recordedAt: iso(raw.recordedAt),
  };
}

export function normalizeBudgetStatus(value: unknown): BudgetStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  return {
    policy: normalizeBudget(raw.policy),
    modelCalls: num(raw.modelCalls),
    steps: num(raw.steps),
    workerAttempts: num(raw.workerAttempts),
    contextExpansions: num(raw.contextExpansions),
    openReservations: num(raw.openReservations),
    wallClockStartedAt:
      typeof raw.wallClockStartedAt === "string" ? raw.wallClockStartedAt : null,
    elapsedMs: nullableNum(raw.elapsedMs),
    exhaustedReason:
      raw.exhaustedReason == null ? null : safeText(raw.exhaustedReason, 500),
  };
}

function collect<T>(value: unknown, mapper: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const output: T[] = [];
  for (const item of value.slice(0, MAX_RENDERED_LIST)) {
    const mapped = mapper(item);
    if (mapped) output.push(mapped);
  }
  return output;
}

/**
 * Task 1 returns its read model at the TOP LEVEL from
 * `GET /api/orchestrations/:orchestrationId`, and wraps only the collection
 * endpoints (`{ events }`, `{ tasks }`, `{ artifacts }`, `{ verifications }`).
 * This function accepts the top-level shape, a `{ readModel: ... }` wrapper,
 * and a bare `Orchestration`, so the panel survives either envelope.
 */
export function normalizeReadModel(value: unknown): OrchestrationReadModel | null {
  const raw = record(value);
  const body = record(raw.readModel ?? raw);
  const orchestration = normalizeOrchestration(body.orchestration ?? body);
  if (!orchestration) return null;
  const applicationMaps = collect(body.applicationMaps, normalizeApplicationMap);
  return {
    orchestration,
    intentDraft: normalizeIntentDraft(body.intentDraft ?? body.intent ?? null),
    intentDraftHistory: collect(body.intentDraftHistory, normalizeIntentDraft),
    contract: normalizeContract(body.activeContract ?? body.contract ?? null),
    contractHistory: collect(body.contractHistory, normalizeContract),
    pendingAmendment: normalizeAmendment(body.pendingAmendment ?? null),
    plan: normalizePlan(body.plan ?? null, applicationMaps),
    applicationMaps,
    tasks: collect(body.tasks, normalizeTask),
    events: collect(body.events, normalizeEvent),
    artifacts: collect(body.artifacts, normalizeArtifact),
    attempts: collect(body.attempts, normalizeAttempt),
    verifications: collect(body.verifications, normalizeVerification),
    contextPackets: collect(body.contextPackets, normalizeContextPacket),
    failurePackets: collect(body.failurePackets, normalizeFailurePacket),
    workspaceDispositions: collect(
      body.workspaceDispositions,
      normalizeWorkspaceDisposition,
    ),
    // Task 1 exposes trusted ledger counters as `budget`; the raw policy also
    // lives on the orchestration itself, so either may be absent.
    budgetStatus: normalizeBudgetStatus(body.budgetStatus ?? body.budget ?? null),
  };
}

/**
 * Merges a collection endpoint response (`{ events }`, `{ tasks }`, …) into an
 * existing view, for hosts that prefer the narrow reads over the read model.
 */
export function mergeCollections(
  view: OrchestrationReadModel,
  collections: {
    events?: unknown;
    tasks?: unknown;
    artifacts?: unknown;
    verifications?: unknown;
  },
): OrchestrationReadModel {
  const unwrap = (value: unknown, key: string): unknown => {
    const wrapper = record(value);
    return Array.isArray(value) ? value : wrapper[key];
  };
  return {
    ...view,
    events:
      collections.events === undefined
        ? view.events
        : collect(unwrap(collections.events, "events"), normalizeEvent),
    tasks:
      collections.tasks === undefined
        ? view.tasks
        : collect(unwrap(collections.tasks, "tasks"), normalizeTask),
    artifacts:
      collections.artifacts === undefined
        ? view.artifacts
        : collect(unwrap(collections.artifacts, "artifacts"), normalizeArtifact),
    verifications:
      collections.verifications === undefined
        ? view.verifications
        : collect(
            unwrap(collections.verifications, "verifications"),
            normalizeVerification,
          ),
  };
}

export function normalizeSummaryList(value: unknown): OrchestrationSummary[] {
  const raw = record(value);
  const list = Array.isArray(raw.orchestrations)
    ? raw.orchestrations
    : Array.isArray(value)
      ? value
      : [];
  const output: OrchestrationSummary[] = [];
  for (const item of list.slice(0, 50)) {
    const entry = record(item);
    if (typeof entry.id !== "string") continue;
    output.push({
      id: entry.id,
      agentId: safeText(entry.agentId, 100),
      status: oneOf(entry.status, ORCHESTRATION_STATUSES, "drafting-intent"),
      requestedMode: oneOf(entry.requestedMode, REQUESTED_MODES, "auto"),
      selectedMode:
        typeof entry.selectedMode === "string" &&
        (SELECTED_MODES as readonly string[]).includes(entry.selectedMode)
          ? (entry.selectedMode as OrchestrationSummary["selectedMode"])
          : null,
      prompt: safeText(entry.prompt, 400),
      createdAt: iso(entry.createdAt),
      updatedAt: iso(entry.updatedAt),
    });
  }
  return output;
}

export function extractOrchestrationId(value: unknown): string | null {
  const raw = record(value);
  if (typeof raw.orchestrationId === "string") return raw.orchestrationId;
  const nested = record(raw.orchestration);
  if (typeof nested.id === "string") return nested.id;
  if (typeof raw.id === "string") return raw.id;
  return null;
}

export function extractBenchmarkId(value: unknown): string | null {
  const raw = record(value);
  if (typeof raw.benchmarkId === "string") return raw.benchmarkId;
  const nested = record(raw.benchmark);
  if (typeof nested.id === "string") return nested.id;
  if (typeof raw.id === "string") return raw.id;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Benchmark normalization                                                    */
/* -------------------------------------------------------------------------- */

const ARM_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
] as const;

function normalizeArm(value: unknown, arm: BenchmarkArm): BenchmarkArmResult {
  const raw = record(value);
  const counters = record(raw.counters);
  return {
    arm,
    status: oneOf(raw.status, ARM_STATUSES, "queued"),
    executionId: typeof raw.executionId === "string" ? safeText(raw.executionId, 120) : null,
    selectedMode:
      typeof raw.selectedMode === "string" &&
      (SELECTED_MODES as readonly string[]).includes(raw.selectedMode)
        ? (raw.selectedMode as BenchmarkArmResult["selectedMode"])
        : null,
    startedFromSnapshotHash:
      typeof raw.startedFromSnapshotHash === "string"
        ? safeText(raw.startedFromSnapshotHash, 64)
        : null,
    workspaceLabel:
      typeof raw.workspaceLabel === "string" ? safeText(raw.workspaceLabel, 200) : null,
    verifications: Array.isArray(raw.verifications)
      ? raw.verifications.slice(0, 60).map((item) => {
          const check = record(item);
          return {
            scope: oneOf(
              check.scope,
              ["worker-visible", "protected", "global", "manual"] as const,
              "global",
            ),
            commandOrCheck: safeText(check.commandOrCheck, 300),
            status: oneOf(check.status, ["passed", "failed", "skipped"] as const, "skipped"),
            outputSummary: safeText(check.outputSummary, 1_500),
          };
        })
      : [],
    succeeded: bool(raw.succeeded),
    usage: normalizeUsageLedger(raw.usage),
    counters: {
      modelCalls: num(counters.modelCalls),
      attempts: num(counters.attempts),
      contextExpansions: num(counters.contextExpansions),
      escalations: num(counters.escalations),
      integrationFailures: num(counters.integrationFailures),
    },
    wallClockMs: num(raw.wallClockMs),
    finalOutputSummary:
      raw.finalOutputSummary == null ? null : safeText(raw.finalOutputSummary, 2_000),
    error: raw.error == null ? null : safeText(raw.error, 1_000),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
  };
}

function normalizeComparison(value: unknown): BenchmarkComparison | null {
  if (!value || typeof value !== "object") return null;
  const raw = record(value);
  const pricingStatus = raw.pricingStatus === "configured" ? "configured" : "unknown";
  return {
    qualityVerdict: oneOf(
      raw.qualityVerdict,
      [
        "both-passed",
        "direct-only",
        "orchestrated-only",
        "neither-passed",
        "incomplete",
      ] as const,
      "incomplete",
    ),
    verificationComparable: bool(raw.verificationComparable),
    costComparable: bool(raw.costComparable),
    tokenVerdict: oneOf(
      raw.tokenVerdict,
      ["direct-better", "orchestrated-better", "tie", "not-comparable"] as const,
      "not-comparable",
    ),
    costVerdict: oneOf(
      raw.costVerdict,
      [
        "direct-better",
        "orchestrated-better",
        "tie",
        "not-comparable",
        "unknown-pricing",
      ] as const,
      "not-comparable",
    ),
    wallClockVerdict: oneOf(
      raw.wallClockVerdict,
      ["direct-better", "orchestrated-better", "tie", "not-comparable"] as const,
      "not-comparable",
    ),
    totalTokenDelta: nullableNum(raw.totalTokenDelta),
    estimatedUsdDelta:
      pricingStatus === "configured" ? nullableNum(raw.estimatedUsdDelta) : null,
    wallClockDeltaMs: nullableNum(raw.wallClockDeltaMs),
    pricingStatus,
    warnings: stringList(raw.warnings, 30),
    limitations: stringList(raw.limitations, 30),
  };
}

export function normalizeBenchmark(value: unknown): BenchmarkRecord | null {
  const envelope = record(value);
  const raw = record(envelope.benchmark ?? envelope);
  if (typeof raw.id !== "string") return null;
  const arms = record(raw.arms);
  return {
    id: raw.id,
    agentId: safeText(raw.agentId, 100),
    prompt: safeText(raw.prompt, 4_000),
    criteria: normalizeCriteria(raw.criteria),
    budget: normalizeBudget(raw.budget),
    status: oneOf(
      raw.status,
      ["running", "completed", "failed", "cancelled"] as const,
      "running",
    ),
    sourceSnapshotHash:
      typeof raw.sourceSnapshotHash === "string"
        ? safeText(raw.sourceSnapshotHash, 64)
        : null,
    armOrder: Array.isArray(raw.armOrder)
      ? raw.armOrder
          .filter(
            (item): item is BenchmarkArm =>
              item === "direct" || item === "orchestrated",
          )
          .slice(0, 2)
      : ["direct", "orchestrated"],
    arms: {
      direct: normalizeArm(arms.direct, "direct"),
      orchestrated: normalizeArm(arms.orchestrated, "orchestrated"),
    },
    comparison: normalizeComparison(raw.comparison),
    error: raw.error == null ? null : safeText(raw.error, 1_000),
    createdAt: iso(raw.createdAt),
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived state                                                              */
/* -------------------------------------------------------------------------- */

export type ExecutionMode = "direct" | "auto" | "orchestrated";

export const EXECUTION_MODES: readonly ExecutionMode[] = [
  "direct",
  "auto",
  "orchestrated",
];

export interface ExecutionModeDescriptor {
  mode: ExecutionMode;
  label: string;
  hint: string;
}

export const EXECUTION_MODE_DESCRIPTORS: readonly ExecutionModeDescriptor[] = [
  {
    mode: "direct",
    label: "Direct",
    hint: "Sends the prompt straight to the existing Playground run. Best for small or tightly coupled work.",
  },
  {
    mode: "auto",
    label: "Auto",
    hint: "The planner confirms intent, then the router may still choose direct execution, one worker, or several workers.",
  },
  {
    mode: "orchestrated",
    label: "Orchestrated",
    hint: "Forces delegation when the confirmed contract can be decomposed within budget; otherwise it fails safely.",
  },
];

export type ModeAction =
  | { kind: "direct" }
  | { kind: "orchestration"; requestedMode: RequestedExecutionMode };

/** The one place that decides what a submit button actually does. */
export function modeToAction(mode: ExecutionMode): ModeAction {
  if (mode === "direct") return { kind: "direct" };
  return { kind: "orchestration", requestedMode: mode };
}

export function isTerminalStatus(status: OrchestrationStatus): boolean {
  return TERMINAL_ORCHESTRATION_STATUSES.includes(status);
}

export function isTerminalBenchmark(record_: BenchmarkRecord): boolean {
  return TERMINAL_BENCHMARK_STATUSES.includes(record_.status);
}

export interface ConfirmationGate {
  canConfirm: boolean;
  reason: string | null;
  unresolvedQuestions: string[];
}

/**
 * Confirmation is explicit and is blocked while any material question is
 * unanswered. Confirmation is never inferred from a model message, from the
 * screen being open, or from an absence of questions in a stale draft.
 */
export function confirmationGate(
  view: OrchestrationReadModel | null,
  answers: Record<string, string>,
): ConfirmationGate {
  if (!view) {
    return { canConfirm: false, reason: "No orchestration loaded", unresolvedQuestions: [] };
  }
  if (view.orchestration.status !== "awaiting-confirmation") {
    return {
      canConfirm: false,
      reason: "The planner is still preparing this interpretation",
      unresolvedQuestions: [],
    };
  }
  const draft = view.intentDraft;
  if (!draft) {
    return {
      canConfirm: false,
      reason: "No intent draft has been recorded yet",
      unresolvedQuestions: [],
    };
  }
  const unresolvedQuestions = draft.materialQuestions.filter(
    (question) => !(answers[question] ?? "").trim(),
  );
  if (unresolvedQuestions.length > 0) {
    return {
      canConfirm: false,
      reason:
        unresolvedQuestions.length +
        " material question" +
        (unresolvedQuestions.length === 1 ? "" : "s") +
        " must be answered before this contract can be confirmed",
      unresolvedQuestions,
    };
  }
  return { canConfirm: true, reason: null, unresolvedQuestions: [] };
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

export function eventMatchesFilter(
  event: OrchestrationEvent,
  filter: EventFilterKey,
): boolean {
  if (filter === "all") return true;
  const pattern = FILTER_PATTERNS[filter];
  if (filter === "role") {
    if (event.actorRole !== "user" && event.actorRole !== "control-plane") return true;
    if (event.modelId) return true;
  }
  if (filter === "task" && event.taskId) return true;
  return pattern.test(event.type) || pattern.test(event.summary);
}

export function filterEvents(
  events: OrchestrationEvent[],
  filter: EventFilterKey,
  taskId?: string | null,
): OrchestrationEvent[] {
  return events.filter(
    (event) =>
      eventMatchesFilter(event, filter) && (!taskId || event.taskId === taskId),
  );
}

export type StatusTone = "pending" | "active" | "success" | "warning" | "danger";

export interface StatusPresentation {
  label: string;
  /** A text glyph so status never depends on colour alone. */
  icon: string;
  tone: StatusTone;
}

const TASK_STATUS_PRESENTATION: Record<OrchestrationTaskStatus, StatusPresentation> = {
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

export function taskStatusPresentation(
  status: OrchestrationTaskStatus,
): StatusPresentation {
  return TASK_STATUS_PRESENTATION[status];
}

const ORCHESTRATION_STATUS_PRESENTATION: Record<
  OrchestrationStatus,
  StatusPresentation
> = {
  "drafting-intent": { label: "Drafting intent", icon: "◐", tone: "active" },
  "awaiting-confirmation": { label: "Awaiting your confirmation", icon: "?", tone: "warning" },
  planning: { label: "Planning", icon: "◐", tone: "active" },
  ready: { label: "Ready to start", icon: "▷", tone: "pending" },
  running: { label: "Running", icon: "◌", tone: "active" },
  integrating: { label: "Integrating", icon: "◍", tone: "active" },
  verifying: { label: "Verifying", icon: "◍", tone: "active" },
  "needs-user": { label: "Needs your decision", icon: "!", tone: "warning" },
  "budget-exhausted": { label: "Budget stop", icon: "⊘", tone: "danger" },
  completed: { label: "Completed", icon: "✓", tone: "success" },
  failed: { label: "Failed", icon: "✕", tone: "danger" },
  cancelled: { label: "Cancelled", icon: "⊘", tone: "warning" },
};

export function orchestrationStatusPresentation(
  status: OrchestrationStatus,
): StatusPresentation {
  return ORCHESTRATION_STATUS_PRESENTATION[status];
}

export function eventTone(event: OrchestrationEvent): StatusTone {
  if (/fail|error|denied|exhaust/i.test(event.type + " " + event.summary)) return "danger";
  if (/cancel|stale|needs-user|escalat|warn/i.test(event.type + " " + event.summary)) {
    return "warning";
  }
  if (/complete|passed|publish|verified|confirm/i.test(event.type + " " + event.summary)) {
    return "success";
  }
  return "pending";
}

/* -------------------------------------------------------------------------- */
/* Usage, budget, and cost                                                    */
/* -------------------------------------------------------------------------- */

export interface UsageRow {
  role: ModelRole;
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  modelCalls: number;
  estimatedUsd: number | null;
}

export interface UsageSummary {
  rows: UsageRow[];
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalModelCalls: number;
  totalEstimatedUsd: number | null;
  pricingStatus: "configured" | "unknown";
  /** Rendered verbatim; the product never says "billed cost". */
  costLabel: string;
}

export const PRICING_NOT_CONFIGURED = "Pricing not configured";

export function formatEstimatedUsd(value: number | null): string {
  if (value === null) return PRICING_NOT_CONFIGURED;
  return "estimated cost $" + value.toFixed(4);
}

export function summarizeUsage(usage: UsageLedger): UsageSummary {
  const rows: UsageRow[] = [];
  for (const role of MODEL_ROLES) {
    const entry = usage.byRole[role];
    if (!entry) continue;
    rows.push({
      role,
      modelId: entry.modelId,
      inputTokens: entry.inputTokens,
      cachedInputTokens: entry.cachedInputTokens,
      outputTokens: entry.outputTokens,
      modelCalls: entry.modelCalls,
      estimatedUsd: usage.pricingStatus === "configured" ? entry.estimatedUsd : null,
    });
  }
  const totalModelCalls = rows.reduce((total, row) => total + row.modelCalls, 0);
  const totalEstimatedUsd =
    usage.pricingStatus === "configured" ? usage.totalEstimatedUsd : null;
  return {
    rows,
    totalInputTokens: usage.totalInputTokens,
    totalCachedInputTokens: usage.totalCachedInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalInputTokens + usage.totalOutputTokens,
    totalModelCalls,
    totalEstimatedUsd,
    pricingStatus: usage.pricingStatus,
    costLabel: formatEstimatedUsd(totalEstimatedUsd),
  };
}

export interface BudgetGauge {
  label: string;
  used: number;
  limit: number | null;
  /** 0..1, or null when the limit is not configured. */
  ratio: number | null;
  exceeded: boolean;
  display: string;
}

export function budgetGauges(
  usage: UsageLedger,
  budget: BudgetPolicy,
  modelCalls: number,
  elapsedMs: number,
): BudgetGauge[] {
  const gauge = (
    label: string,
    used: number,
    limit: number | null,
    suffix = "",
  ): BudgetGauge => ({
    label,
    used,
    limit,
    ratio: limit && limit > 0 ? Math.min(1, used / limit) : null,
    exceeded: limit != null && limit > 0 && used >= limit,
    display:
      limit == null || limit === 0
        ? used.toLocaleString() + suffix + " used · no hard limit"
        : used.toLocaleString() + suffix + " / " + limit.toLocaleString() + suffix,
  });
  const gauges: BudgetGauge[] = [
    gauge("Input tokens", usage.totalInputTokens, budget.maxInputTokens),
    gauge("Output tokens", usage.totalOutputTokens, budget.maxOutputTokens),
    gauge("Model calls", modelCalls, budget.maxModelCalls || null),
    gauge("Wall clock", Math.round(elapsedMs / 1000), Math.round(budget.maxWallClockMs / 1000) || null, "s"),
  ];
  if (usage.pricingStatus === "configured" && budget.maxEstimatedUsd != null) {
    gauges.push({
      label: "Estimated cost",
      used: usage.totalEstimatedUsd ?? 0,
      limit: budget.maxEstimatedUsd,
      ratio: Math.min(1, (usage.totalEstimatedUsd ?? 0) / budget.maxEstimatedUsd),
      exceeded: (usage.totalEstimatedUsd ?? 0) >= budget.maxEstimatedUsd,
      display:
        "$" +
        (usage.totalEstimatedUsd ?? 0).toFixed(4) +
        " / $" +
        budget.maxEstimatedUsd.toFixed(2),
    });
  }
  return gauges;
}

export interface EstimateComparison {
  tokenRange: string;
  costRange: string;
  actualTokens: number;
  actualCost: string;
  overHighEstimate: boolean;
}

export function compareEstimateToActual(
  estimate: CostEstimate | null,
  usage: UsageLedger,
): EstimateComparison | null {
  if (!estimate) return null;
  const low = estimate.inputTokenLow + estimate.outputTokenLow;
  const high = estimate.inputTokenHigh + estimate.outputTokenHigh;
  const actualTokens = usage.totalInputTokens + usage.totalOutputTokens;
  return {
    tokenRange: low.toLocaleString() + " – " + high.toLocaleString() + " tokens",
    costRange:
      estimate.pricingStatus === "configured" &&
      estimate.estimatedUsdLow != null &&
      estimate.estimatedUsdHigh != null
        ? "estimated cost $" +
          estimate.estimatedUsdLow.toFixed(4) +
          " – $" +
          estimate.estimatedUsdHigh.toFixed(4)
        : PRICING_NOT_CONFIGURED,
    actualTokens,
    actualCost: formatEstimatedUsd(
      usage.pricingStatus === "configured" ? usage.totalEstimatedUsd : null,
    ),
    overHighEstimate: high > 0 && actualTokens > high,
  };
}

/** Aggregated evidence counters shown next to usage. */
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

/**
 * Trusted ledger counters win where the control plane provides them; event
 * counting is only the fallback for a server that does not.
 */
export function evidenceCounters(view: OrchestrationReadModel): EvidenceCounters {
  const events = view.events;
  const countEvents = (pattern: RegExp) =>
    events.filter((event) => pattern.test(event.type)).length;
  const ledger = view.budgetStatus;
  return {
    tasks: view.tasks.length,
    attempts: ledger ? Math.max(ledger.workerAttempts, view.attempts.length) : view.attempts.length,
    contextExpansions: ledger
      ? ledger.contextExpansions
      : countEvents(/context[-_.]?expansion/i),
    escalations: countEvents(/escalat/i),
    integrationFailures: countEvents(/integration[-_.]?fail/i),
    verifications: view.verifications.length,
    failedVerifications: view.verifications.filter((item) => item.status === "failed")
      .length,
    artifacts: view.artifacts.length,
    staleRefreshes: countEvents(/stale|refresh/i),
  };
}

/** The exact budget-stop reason, preferring the control plane's own text. */
export function budgetStopReason(view: OrchestrationReadModel): string | null {
  if (view.budgetStatus?.exhaustedReason) return view.budgetStatus.exhaustedReason;
  if (view.orchestration.status !== "budget-exhausted") return null;
  const event = view.events.find((item) => /budget/i.test(item.type));
  return event?.summary ?? view.orchestration.error ?? "The hard budget was reached.";
}

/** Wall-clock elapsed time, preferring the server's own measurement. */
export function elapsedMsFor(
  view: OrchestrationReadModel,
  nowMs: number,
): number {
  if (view.budgetStatus?.elapsedMs != null) return view.budgetStatus.elapsedMs;
  const started = Date.parse(view.orchestration.createdAt);
  if (Number.isNaN(started)) return 0;
  const finished = view.orchestration.completedAt
    ? Date.parse(view.orchestration.completedAt)
    : nowMs;
  return Math.max(0, (Number.isNaN(finished) ? nowMs : finished) - started);
}

/* -------------------------------------------------------------------------- */
/* Benchmark presentation                                                     */
/* -------------------------------------------------------------------------- */

export interface BenchmarkArmPresentation {
  arm: BenchmarkArm;
  label: string;
  status: StatusPresentation;
  /** Rendered before any token or dollar figure. */
  qualityLine: string;
  verifications: BenchmarkArmResult["verifications"];
  usage: UsageSummary;
  wallClockMs: number;
  counters: BenchmarkArmResult["counters"];
  route: string;
  error: string | null;
}

export interface BenchmarkPresentation {
  status: BenchmarkStatusLabel;
  qualityHeadline: string;
  costHeadline: string;
  costWithheld: boolean;
  arms: BenchmarkArmPresentation[];
  warnings: string[];
  limitations: string[];
  snapshotLine: string;
}

export interface BenchmarkStatusLabel {
  label: string;
  icon: string;
  tone: StatusTone;
}

const ARM_STATUS_PRESENTATION: Record<
  BenchmarkArmResult["status"],
  StatusPresentation
> = {
  queued: { label: "Queued", icon: "▢", tone: "pending" },
  running: { label: "Running", icon: "◌", tone: "active" },
  succeeded: { label: "Verified pass", icon: "✓", tone: "success" },
  failed: { label: "Did not pass", icon: "✕", tone: "danger" },
  cancelled: { label: "Cancelled", icon: "⊘", tone: "warning" },
  skipped: { label: "Not run", icon: "–", tone: "pending" },
};

const QUALITY_HEADLINES: Record<
  NonNullable<BenchmarkComparison["qualityVerdict"]>,
  string
> = {
  "both-passed": "Both arms passed the same trusted checks.",
  "direct-only": "Only the direct arm passed. Orchestration did not reach the same quality.",
  "orchestrated-only": "Only the orchestrated arm passed. Direct execution did not reach the same quality.",
  "neither-passed": "Neither arm passed. There is no quality result to compare.",
  incomplete: "The benchmark did not finish both arms.",
};

function costHeadlineFor(comparison: BenchmarkComparison | null): string {
  if (!comparison) return "No comparison recorded yet.";
  if (!comparison.costComparable) {
    return "Cost comparison withheld until both arms reach the same verified quality.";
  }
  if (comparison.costVerdict === "unknown-pricing") {
    return (
      PRICING_NOT_CONFIGURED +
      ". Token totals differ by " +
      (comparison.totalTokenDelta ?? 0).toLocaleString() +
      " (orchestrated minus direct)."
    );
  }
  if (comparison.costVerdict === "tie") return "Estimated cost was equal.";
  const winner = comparison.costVerdict === "direct-better" ? "Direct" : "Orchestrated";
  const delta = comparison.estimatedUsdDelta;
  return (
    winner +
    " execution had the lower estimated cost" +
    (delta === null ? "." : " by $" + Math.abs(delta).toFixed(4) + ".")
  );
}

export function presentBenchmark(record_: BenchmarkRecord): BenchmarkPresentation {
  const comparison = record_.comparison;
  const arms: BenchmarkArmPresentation[] = (["direct", "orchestrated"] as const).map(
    (arm) => {
      const armRecord = record_.arms[arm];
      const failedTrusted = armRecord.verifications.filter(
        (check) =>
          check.status === "failed" &&
          (check.scope === "protected" || check.scope === "global"),
      ).length;
      return {
        arm,
        label: arm === "direct" ? "Direct baseline" : "Orchestrated",
        status: ARM_STATUS_PRESENTATION[armRecord.status],
        qualityLine:
          armRecord.status === "succeeded" && failedTrusted === 0
            ? "Passed every trusted check that ran."
            : failedTrusted > 0
              ? failedTrusted + " trusted check(s) failed."
              : "No verified pass recorded.",
        verifications: armRecord.verifications,
        usage: summarizeUsage(armRecord.usage),
        wallClockMs: armRecord.wallClockMs,
        counters: armRecord.counters,
        route: armRecord.selectedMode ?? "not recorded",
        error: armRecord.error,
      };
    },
  );

  const statusPresentation: BenchmarkStatusLabel =
    record_.status === "completed"
      ? { label: "Completed", icon: "✓", tone: "success" }
      : record_.status === "running"
        ? { label: "Running", icon: "◌", tone: "active" }
        : record_.status === "cancelled"
          ? { label: "Cancelled", icon: "⊘", tone: "warning" }
          : { label: "Failed", icon: "✕", tone: "danger" };

  return {
    status: statusPresentation,
    qualityHeadline: comparison
      ? QUALITY_HEADLINES[comparison.qualityVerdict]
      : "Waiting for both arms to finish.",
    costHeadline: costHeadlineFor(comparison),
    costWithheld: !comparison?.costComparable,
    arms,
    warnings: comparison?.warnings ?? [],
    limitations: comparison?.limitations ?? [],
    snapshotLine: record_.sourceSnapshotHash
      ? "Both arms started from workspace snapshot " +
        record_.sourceSnapshotHash.slice(0, 12)
      : "Snapshot not captured",
  };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds % 60) + "s";
}

export function formatTokens(value: number): string {
  return value.toLocaleString();
}
