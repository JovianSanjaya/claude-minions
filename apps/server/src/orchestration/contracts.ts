/**
 * DEVIATIONS FROM THE ORIGINAL APPENDIX A TEXT (documented per the spec's
 * "smallest coherent change" rule — see docs/handoffs/task-1-control-plane.md
 * and docs/handoffs/task-2-engine.md for full rationale):
 *
 * 1. `IntentDraft`'s five claim arrays (`requirements`, `assumptions`,
 *    `nonGoals`, `architectureDecisions`, `manualExpectations`) changed
 *    element type from `string` to `IntentClaim`, and `materialQuestions:
 *    string[]` was renamed/retyped to `openQuestions: ClarificationQuestion[]`.
 *    This is the core of the common-ground redesign: provenance
 *    (user-explicit / planner-inferred / repository-derived / user-delegated)
 *    must be inspectable per claim, not collapsed into an opaque string.
 * 2. `ContractCriterion` gained `provenance` and `sourceClaimId` so a
 *    confirmed contract can answer "why does the system believe this is
 *    part of the contract" by tracing a criterion back to its source claim.
 * 3. `ElaborateIntentInput` gained `priorDraft: IntentDraft | null` so a
 *    revision/re-elaboration call can ground itself in what was already
 *    established instead of starting over from the raw prompt each time.
 *
 * Nothing else in this file changed. All other types, and all four
 * `OrchestrationExecutionDriver` method signatures, are unchanged.
 */

export type RequestedExecutionMode = "auto" | "direct" | "orchestrated";
export type SelectedExecutionMode = "direct" | "one-worker" | "multi-worker";
export type ModelRole = "planner" | "worker" | "verifier" | "integrator";

/** Where a piece of intent came from — the core of the common-ground design. */
export type IntentProvenance =
  | "user-explicit"
  | "planner-inferred"
  | "repository-derived"
  | "user-delegated";

/**
 * Two levels only, deliberately: this is a control input, not a cosmetic
 * confidence score. "material" means unresolved ambiguity here can block
 * confirmation; "trivial" means the control plane may resolve it
 * autonomously without interrupting the user.
 */
export type IntentMateriality = "trivial" | "material";

/** Which claim array on an IntentDraft a clarification question resolves into. */
export type IntentCategory =
  | "requirements"
  | "assumptions"
  | "nonGoals"
  | "architectureDecisions"
  | "manualExpectations";

export interface IntentClaim {
  id: string;
  text: string;
  provenance: IntentProvenance;
  materiality: IntentMateriality;
  /** Why the planner believes this; null when provenance is user-supplied. */
  rationale: string | null;
  /** id of a prior claim (from an earlier draft revision) this one replaces, if any. */
  supersedes: string | null;
}

export interface ClarificationOption {
  id: string;
  label: string;
  /** The concrete claim text this option asserts if chosen. */
  resolutionText: string;
  /** True for the "let the AI decide" option. */
  delegate: boolean;
}

export interface ClarificationQuestion {
  id: string;
  prompt: string;
  /** The planner's own materiality judgment; the control plane re-checks it (see clarification-policy.ts). */
  materiality: IntentMateriality;
  /** What could go wrong if this is misunderstood — shown to the user, and used by the safety-net policy check. */
  consequenceIfWrong: string;
  options: ClarificationOption[];
  /** Which IntentDraft array the resolution claim is appended to. */
  category: IntentCategory;
  relatedClaimIds: string[];
}

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

export interface ContractCriterion {
  id: string;
  kind: "functional" | "architectural" | "scope" | "runtime" | "manual";
  description: string;
  verification: "visible-test" | "protected-test" | "static-check" | "manual";
  provenance: IntentProvenance;
  /** id of the IntentClaim this criterion was derived from; null for control-plane-imposed baseline criteria. */
  sourceClaimId: string | null;
}

export interface IntentDraft {
  id: string;
  orchestrationId: string;
  revision: number;
  goal: string;
  requirements: IntentClaim[];
  assumptions: IntentClaim[];
  nonGoals: IntentClaim[];
  architectureDecisions: IntentClaim[];
  manualExpectations: IntentClaim[];
  openQuestions: ClarificationQuestion[];
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

export interface VerificationRecord {
  id: string;
  orchestrationId: string;
  taskId: string | null;
  scope: "worker-visible" | "protected" | "global" | "manual";
  commandOrCheck: string;
  status: "passed" | "failed" | "skipped";
  outputSummary: string;
  startedAt: string;
  completedAt: string;
}

export interface OrchestrationEvent {
  id: string;
  orchestrationId: string;
  taskId: string | null;
  executionId: string | null;
  type: string;
  actorRole: "user" | ModelRole | "control-plane" | "runtime";
  modelId: string | null;
  summary: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface PlanResult {
  selectedMode: SelectedExecutionMode;
  routeReason: string;
  tasks: OrchestrationTask[];
  applicationMap: ApplicationMapSummary;
}

export type ExecutionOutcome =
  | { kind: "completed"; finalOutput: string }
  | { kind: "needs-user"; amendment: ContractAmendment }
  | { kind: "budget-exhausted"; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string };

export interface ModelCallReservation {
  orchestrationId: string;
  taskId: string | null;
  executionId: string;
  role: ModelRole;
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export type BudgetDecision =
  | { allowed: true; reservationId: string }
  | { allowed: false; reason: string };

export interface OrchestrationSink {
  reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision>;
  commitModelUsage(
    reservationId: string,
    actual: TokenUsage,
  ): Promise<void>;
  recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void>;
  upsertTask(task: OrchestrationTask): Promise<void>;
  recordApplicationMap(map: ApplicationMapSummary): Promise<void>;
  recordContextPacket(packet: ContextPacketSummary): Promise<void>;
  recordAttempt(attempt: WorkerAttempt): Promise<void>;
  publishArtifact(artifact: SharedArtifact): Promise<void>;
  recordVerification(record: VerificationRecord): Promise<void>;
}

export interface ElaborateIntentInput {
  orchestrationId: string;
  agentId: string;
  prompt: string;
  requestedMode: RequestedExecutionMode;
  budget: BudgetPolicy;
  workspacePath: string;
  /** The current draft, when this call is a revision/re-elaboration rather than the first pass. */
  priorDraft: IntentDraft | null;
}

export interface PlanInput {
  orchestration: Orchestration;
  contract: ExecutionContract;
  workspacePath: string;
}

export interface ExecuteInput extends PlanInput {
  plan: PlanResult;
}

export interface OrchestrationExecutionDriver {
  elaborateIntent(
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<{ draft: IntentDraft; estimate: CostEstimate }>;
  plan(
    input: PlanInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<PlanResult>;
  execute(
    input: ExecuteInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome>;
  cancel(orchestrationId: string): Promise<boolean>;
}
