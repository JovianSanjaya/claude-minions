/**
 * Browser DTOs for the orchestration middleware.
 *
 * These types are structurally aligned with the frozen server contract in
 * `apps/server/src/orchestration/contracts.ts` (specification Appendix A) and
 * with the Task 1 read model. They are deliberately re-declared here rather
 * than imported: the browser bundle must not reach into the server workspace,
 * and the UI must keep compiling before Task 1 exists.
 *
 * Everything that arrives over the network is `unknown` until it passes
 * through `view-model.ts`. Nothing in this file performs a cast.
 */

export type RequestedExecutionMode = "auto" | "direct" | "orchestrated";
export type SelectedExecutionMode = "direct" | "one-worker" | "multi-worker";
export type ModelRole = "planner" | "worker" | "verifier" | "integrator";

export const MODEL_ROLES: readonly ModelRole[] = [
  "planner",
  "worker",
  "verifier",
  "integrator",
];

export type OrchestrationStatus =
  | "drafting-intent"
  | "awaiting-confirmation"
  | "planning"
  | "ready"
  | "running"
  | "integrating"
  | "verifying"
  | "needs-user"
  | "budget-exhausted"
  | "completed"
  | "failed"
  | "cancelled";

export const ORCHESTRATION_STATUSES: readonly OrchestrationStatus[] = [
  "drafting-intent",
  "awaiting-confirmation",
  "planning",
  "ready",
  "running",
  "integrating",
  "verifying",
  "needs-user",
  "budget-exhausted",
  "completed",
  "failed",
  "cancelled",
];

/** Terminal states never poll again. */
export const TERMINAL_ORCHESTRATION_STATUSES: readonly OrchestrationStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
];

export type OrchestrationTaskStatus =
  | "blocked"
  | "ready"
  | "preflight"
  | "running"
  | "verifying"
  | "stale"
  | "passed"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly OrchestrationTaskStatus[] = [
  "blocked",
  "ready",
  "preflight",
  "running",
  "verifying",
  "stale",
  "passed",
  "failed",
  "cancelled",
];

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface RoleUsage extends TokenUsage {
  modelId: string;
  estimatedUsd: number | null;
  modelCalls: number;
}

export interface UsageLedger {
  byRole: Partial<Record<ModelRole, RoleUsage>>;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedUsd: number | null;
  pricingStatus: "configured" | "unknown";
}

export interface BudgetPolicy {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxEstimatedUsd: number | null;
  maxModelCalls: number;
  maxSteps: number;
  maxWorkerAttempts: number;
  maxContextExpansionsPerTask: number;
  maxWallClockMs: number;
}

export interface CostEstimate {
  inputTokenLow: number;
  inputTokenHigh: number;
  outputTokenLow: number;
  outputTokenHigh: number;
  estimatedUsdLow: number | null;
  estimatedUsdHigh: number | null;
  pricingStatus: "configured" | "unknown";
  assumptions: string[];
}

export type CriterionKind =
  | "functional"
  | "architectural"
  | "scope"
  | "runtime"
  | "manual";

export type CriterionVerification =
  | "visible-test"
  | "protected-test"
  | "static-check"
  | "manual";

export interface ContractCriterion {
  id: string;
  kind: CriterionKind;
  description: string;
  verification: CriterionVerification;
}

export interface IntentDraft {
  id: string;
  orchestrationId: string;
  revision: number;
  goal: string;
  requirements: string[];
  assumptions: string[];
  nonGoals: string[];
  architectureDecisions: string[];
  materialQuestions: string[];
  manualExpectations: string[];
  createdAt: string;
}

export interface ExecutionContract {
  id: string;
  orchestrationId: string;
  version: number;
  intent: IntentDraft;
  criteria: ContractCriterion[];
  confirmedBy: "user";
  confirmedAt: string;
  supersedesContractId: string | null;
}

export interface ContractAmendment {
  id: string;
  orchestrationId: string;
  baseContractId: string;
  proposedIntent: IntentDraft;
  proposedCriteria: ContractCriterion[] | null;
  reason: string;
  material: boolean;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export interface Orchestration {
  id: string;
  agentId: string;
  prompt: string;
  requestedMode: RequestedExecutionMode;
  selectedMode: SelectedExecutionMode | null;
  status: OrchestrationStatus;
  currentIntentDraftId: string | null;
  activeContractId: string | null;
  estimate: CostEstimate | null;
  budget: BudgetPolicy;
  usage: UsageLedger;
  finalOutput: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OrchestrationTask {
  id: string;
  orchestrationId: string;
  title: string;
  objective: string;
  status: OrchestrationTaskStatus;
  dependsOn: string[];
  allowedPaths: string[];
  acceptanceCriterionIds: string[];
  requiredArtifactIds: string[];
  observedArtifactVersions: Record<string, number>;
  applicationMapVersion: number;
  attemptCount: number;
}

export interface ApplicationMapSummary {
  orchestrationId: string;
  version: number;
  repositoryHash: string;
  summary: string;
  fileCount: number;
  createdAt: string;
}

export interface ContextPacketSummary {
  taskId: string;
  applicationMapVersion: number;
  contractVersion: number;
  sourceFiles: Array<{ path: string; sha256: string; bytes: number }>;
  relevantInterfaces: string[];
  artifactVersions: Record<string, number>;
  estimatedTokens: number;
}

export interface SharedArtifact {
  id: string;
  orchestrationId: string;
  producerTaskId: string;
  kind: "api" | "interface" | "schema" | "decision" | "manifest" | "test-result";
  name: string;
  version: number;
  /** Bounded by the view model; never rendered raw when large. */
  payload: string;
  createdAt: string;
}

export interface WorkerAttempt {
  id: string;
  orchestrationId: string;
  taskId: string;
  number: number;
  executionId: string;
  modelId: string;
  contextFileHashes: string[];
  changedFiles: string[];
  status: "running" | "passed" | "failed" | "cancelled";
  usage: TokenUsage;
  errorSummary: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface FailurePacket {
  taskId: string;
  contractVersion: number;
  attemptCount: number;
  lastError: string;
  failingChecks: string[];
  changedFiles: string[];
  diffSummary: string;
  relevantInterfaces: string[];
  workerDiagnosis: string;
  usage: TokenUsage;
}

export type VerificationScope = "worker-visible" | "protected" | "global" | "manual";

export interface VerificationRecord {
  id: string;
  orchestrationId: string;
  taskId: string | null;
  scope: VerificationScope;
  commandOrCheck: string;
  status: "passed" | "failed" | "skipped";
  outputSummary: string;
  startedAt: string;
  completedAt: string;
}

export type EventActor = "user" | ModelRole | "control-plane" | "runtime";

export interface OrchestrationEvent {
  id: string;
  orchestrationId: string;
  taskId: string | null;
  executionId: string | null;
  type: string;
  actorRole: EventActor;
  modelId: string | null;
  summary: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface PlanSummary {
  selectedMode: SelectedExecutionMode;
  routeReason: string;
  applicationMapVersion: number;
  taskIds: string[];
  /** Resolved from the read model's `applicationMaps` collection. */
  applicationMap: ApplicationMapSummary | null;
}

/**
 * Trusted budget accounting, mirroring Task 1's `BudgetStatusView`. The
 * counters come from the control plane's ledger, never from the browser.
 */
export interface BudgetStatus {
  policy: BudgetPolicy;
  modelCalls: number;
  steps: number;
  workerAttempts: number;
  contextExpansions: number;
  openReservations: number;
  wallClockStartedAt: string | null;
  elapsedMs: number | null;
  /** The exact reason new work was stopped, when the budget was exhausted. */
  exhaustedReason: string | null;
}

/** Temporary worker state cleanup/archive policy, for the evidence panel. */
export interface WorkspaceDisposition {
  orchestrationId: string;
  taskId: string | null;
  policy: "cleaned" | "archived" | "retained-for-debugging" | "unknown";
  /** Masked by the control plane; never an unrestricted host path. */
  location: string | null;
  reason: string;
  recordedAt: string;
}

/**
 * The shape the panel renders.
 *
 * Task 1's `GET /api/orchestrations/:orchestrationId` returns its read model at
 * the top level (not wrapped). Field names follow that response; the view model
 * also accepts the alternative spellings so either envelope keeps working, and
 * anything a server omits is normalized to an empty, safe value.
 */
export interface OrchestrationReadModel {
  orchestration: Orchestration;
  intentDraft: IntentDraft | null;
  /** Every revision, so the interpretation history stays visible. */
  intentDraftHistory: IntentDraft[];
  contract: ExecutionContract | null;
  /** Immutable confirmed versions, oldest first. */
  contractHistory: ExecutionContract[];
  pendingAmendment: ContractAmendment | null;
  plan: PlanSummary | null;
  applicationMaps: ApplicationMapSummary[];
  tasks: OrchestrationTask[];
  events: OrchestrationEvent[];
  artifacts: SharedArtifact[];
  attempts: WorkerAttempt[];
  verifications: VerificationRecord[];
  contextPackets: ContextPacketSummary[];
  failurePackets: FailurePacket[];
  workspaceDispositions: WorkspaceDisposition[];
  budgetStatus: BudgetStatus | null;
}

export interface OrchestrationSummary {
  id: string;
  agentId: string;
  status: OrchestrationStatus;
  requestedMode: RequestedExecutionMode;
  selectedMode: SelectedExecutionMode | null;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Benchmark DTOs (Task 3 server module)                                      */
/* -------------------------------------------------------------------------- */

export type BenchmarkArm = "direct" | "orchestrated";
export type BenchmarkStatus = "running" | "completed" | "failed" | "cancelled";
export type BenchmarkArmStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface BenchmarkVerificationSummary {
  scope: VerificationScope;
  commandOrCheck: string;
  status: "passed" | "failed" | "skipped";
  outputSummary: string;
}

export interface BenchmarkCounters {
  modelCalls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
}

export interface BenchmarkArmResult {
  arm: BenchmarkArm;
  status: BenchmarkArmStatus;
  executionId: string | null;
  selectedMode: SelectedExecutionMode | null;
  startedFromSnapshotHash: string | null;
  workspaceLabel: string | null;
  verifications: BenchmarkVerificationSummary[];
  succeeded: boolean;
  usage: UsageLedger;
  counters: BenchmarkCounters;
  wallClockMs: number;
  finalOutputSummary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type QualityVerdict =
  | "both-passed"
  | "direct-only"
  | "orchestrated-only"
  | "neither-passed"
  | "incomplete";

export type ComparisonVerdict =
  | "direct-better"
  | "orchestrated-better"
  | "tie"
  | "not-comparable";

export type CostVerdict = ComparisonVerdict | "unknown-pricing";

export interface BenchmarkComparison {
  qualityVerdict: QualityVerdict;
  verificationComparable: boolean;
  costComparable: boolean;
  tokenVerdict: ComparisonVerdict;
  costVerdict: CostVerdict;
  wallClockVerdict: ComparisonVerdict;
  totalTokenDelta: number | null;
  estimatedUsdDelta: number | null;
  wallClockDeltaMs: number | null;
  pricingStatus: "configured" | "unknown";
  warnings: string[];
  limitations: string[];
}

export interface BenchmarkRecord {
  id: string;
  agentId: string;
  prompt: string;
  criteria: ContractCriterion[];
  budget: BudgetPolicy;
  status: BenchmarkStatus;
  sourceSnapshotHash: string | null;
  armOrder: BenchmarkArm[];
  arms: Record<BenchmarkArm, BenchmarkArmResult>;
  comparison: BenchmarkComparison | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const TERMINAL_BENCHMARK_STATUSES: readonly BenchmarkStatus[] = [
  "completed",
  "failed",
  "cancelled",
];
