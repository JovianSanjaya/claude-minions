/**
 * Browser-side mirror of the server's orchestration DTOs
 * (apps/server/src/orchestration/contracts.ts + the control-plane read
 * model). apps/web has no build-time link to apps/server, so this is a
 * deliberate, hand-kept copy rather than an import — Final Assembly should
 * keep the two in sync if the server-side shapes change.
 */

export type RequestedExecutionMode = "auto" | "direct" | "orchestrated";
export type SelectedExecutionMode = "direct" | "one-worker" | "multi-worker";
export type ModelRole = "planner" | "worker" | "verifier" | "integrator";

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

export type IntentProvenance = "user-explicit" | "planner-inferred" | "repository-derived" | "user-delegated";
export type IntentMateriality = "trivial" | "material";
export type IntentCategory = "requirements" | "assumptions" | "nonGoals" | "architectureDecisions" | "manualExpectations";

export interface IntentClaim {
  id: string;
  text: string;
  provenance: IntentProvenance;
  materiality: IntentMateriality;
  rationale: string | null;
  supersedes: string | null;
}

export interface ClarificationOption {
  id: string;
  label: string;
  resolutionText: string;
  delegate: boolean;
}

export interface ClarificationQuestion {
  id: string;
  prompt: string;
  materiality: IntentMateriality;
  consequenceIfWrong: string;
  options: ClarificationOption[];
  category: IntentCategory;
  relatedClaimIds: string[];
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

export interface ContractCriterion {
  id: string;
  kind: "functional" | "architectural" | "scope" | "runtime" | "manual";
  description: string;
  verification: "visible-test" | "protected-test" | "static-check" | "manual";
  provenance: IntentProvenance;
  sourceClaimId: string | null;
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

export interface RoleUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
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
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  errorSummary: string | null;
  createdAt: string;
  completedAt: string | null;
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

/** GET /api/orchestrations/:id response shape. */
export interface OrchestrationReadModel {
  orchestration: Orchestration;
  currentDraft: IntentDraft | null;
  draftHistory: IntentDraft[];
  activeContract: ExecutionContract | null;
  contractHistory: ExecutionContract[];
  amendments: ContractAmendment[];
  pendingAmendment: ContractAmendment | null;
  applicationMap: ApplicationMapSummary | null;
  tasks: OrchestrationTask[];
  artifacts: SharedArtifact[];
  verifications: VerificationRecord[];
  attempts: WorkerAttempt[];
  events: OrchestrationEvent[];
}

export interface BenchmarkArmResult {
  mode: "direct" | "orchestrated";
  modelIds: Record<string, string>;
  success: boolean;
  verificationSummary: string;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  estimatedUsd: number | null;
  pricingStatus: "configured" | "unknown";
  wallClockMs: number;
  modelCalls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
  error: string | null;
}

export interface BenchmarkRecord {
  id: string;
  agentId: string;
  workspaceSnapshotHash: string;
  prompt: string;
  criteria: ContractCriterion[];
  status: "running" | "completed" | "failed" | "cancelled";
  direct: BenchmarkArmResult | null;
  orchestrated: BenchmarkArmResult | null;
  comparabilityWarnings: string[];
  createdAt: string;
  completedAt: string | null;
}
