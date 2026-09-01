export type RequestedMode = "auto" | "direct" | "orchestrated";
export type SelectedMode = "direct" | "one-worker" | "multi-worker";
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
export type ActorRole =
  | "user"
  | "planner"
  | "worker"
  | "verifier"
  | "integrator"
  | "control-plane"
  | "runtime";

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

export interface IntentDraft {
  id: string;
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

export interface UsageRole {
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
  modelCalls: number;
}

export interface UsageLedger {
  byRole: Partial<Record<ModelRole, UsageRole>>;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedUsd: number | null;
  pricingStatus: "configured" | "unknown";
}

export interface OrchestrationSummary {
  id: string;
  agentId: string;
  prompt: string;
  requestedMode: RequestedMode;
  selectedMode: SelectedMode | null;
  status: OrchestrationStatus;
  estimate: CostEstimate | null;
  budget: BudgetPolicy;
  usage: UsageLedger;
  finalOutput: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ContractCriterion {
  id: string;
  kind: "functional" | "architectural" | "scope" | "runtime" | "manual";
  description: string;
  verification: "visible-test" | "protected-test" | "static-check" | "manual";
}

export interface ExecutionContract {
  id: string;
  version: number;
  intent: IntentDraft;
  criteria: ContractCriterion[];
  confirmedAt: string;
}

export interface OrchestrationTask {
  id: string;
  title: string;
  objective: string;
  status: OrchestrationTaskStatus;
  dependsOn: string[];
  allowedPaths: string[];
  acceptanceCriterionIds: string[];
  requiredArtifactIds: string[];
  observedArtifactVersions: Record<string, number>;
  attemptCount: number;
  applicationMapVersion: number;
}

export interface OrchestrationEvent {
  id: string;
  taskId: string | null;
  executionId: string | null;
  type: string;
  actorRole: ActorRole;
  modelId: string | null;
  summary: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface VerificationRecord {
  id: string;
  taskId: string | null;
  scope: "worker-visible" | "protected" | "global" | "manual";
  commandOrCheck: string;
  status: "passed" | "failed" | "skipped";
  outputSummary: string;
  startedAt: string;
  completedAt: string;
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
  name: string;
  kind: string;
  version: number;
  producerTaskId: string;
  payload: string;
  createdAt: string;
}

export interface WorkerAttempt {
  id: string;
  taskId: string;
  number: number;
  executionId: string;
  modelId: string;
  contextFileHashes: string[];
  status: string;
  changedFiles: string[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  errorSummary: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ApplicationMapSummary {
  version: number;
  repositoryHash: string;
  summary: string;
  fileCount: number;
  createdAt?: string;
}

export interface OrchestrationReadModel {
  orchestration: OrchestrationSummary;
  activeDraft: IntentDraft | null;
  activeContract: ExecutionContract | null;
  pendingAmendment: {
    id: string;
    reason: string;
    status: string;
    proposedIntent: IntentDraft;
  } | null;
  plan: {
    selectedMode: SelectedMode;
    routeReason: string;
    applicationMapVersion: number;
  } | null;
  tasks: OrchestrationTask[];
  usage: UsageLedger;
  events: OrchestrationEvent[];
  artifacts: SharedArtifact[];
  attempts: WorkerAttempt[];
  verifications: VerificationRecord[];
  applicationMaps: ApplicationMapSummary[];
  contextPackets: ContextPacketSummary[];
  cleanup: { policy: string; status: string; summary: string } | null;
}

export interface ClarificationOptionView {
  id: string;
  label: string;
  resolutionText: string;
  delegate: boolean;
}

/** Presentation-only shape adapted from Julian without changing the frozen server contract. */
export interface ClarificationQuestionView {
  id: string;
  prompt: string;
  consequenceIfWrong: string;
  options: ClarificationOptionView[];
  rawQuestion: string;
}

export interface BenchmarkRecord {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  snapshotHash: string;
  direct: BenchmarkArm | null;
  orchestrated: BenchmarkArm | null;
  comparabilityWarnings: string[];
  limitations: string[];
  error: string | null;
}

export interface BenchmarkArm {
  verificationPassed: boolean;
  verificationSummary: string;
  modelIds: string[];
  logicalRoles: string[];
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  estimatedUsd: number | null;
  wallClockMs: number;
  calls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
  outputSummary: string;
  error: string | null;
}
