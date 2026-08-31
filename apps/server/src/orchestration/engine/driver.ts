import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionOutcome,
  IntentDraft,
  Orchestration,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  PlanInput,
  PlanResult,
  TokenUsage,
  VerificationRecord,
} from "../contracts.js";
import type { AgentRunner } from "../../types.js";
import {
  buildApplicationMap,
  isProtectedEnvironmentPath,
  type DetailedApplicationMap,
} from "./application-map.js";
import {
  consolidateAcceptanceTests,
  comprehensiveAcceptanceTests,
  plannedAcceptanceTestSchema,
  requiresPostReleaseVerification,
} from "./acceptance-plan.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { classifyFailure } from "./failure-packet.js";
import { DeterministicIntegrator, type IntegrationCandidate } from "./integrator.js";
import {
  isInternalInfrastructureFailure,
  looksUserActionableFailure,
  recoveryDecisionSchema,
  recoveryEvidence,
  type RecoveryDecision,
} from "./recovery.js";
import {
  isVerificationInfrastructureFailure,
  RoleExecutor,
  type RoleModelConfiguration,
} from "./role-executor.js";
import {
  overlappingWriteScopeConflicts,
  selectRoute,
  tasksHaveOverlappingWriteScopes,
} from "./router.js";
import { requiredVerificationPassed, type TrustedVerificationCheck, VerificationService } from "./verification.js";
import {
  BoundedWorkerLoop,
  type WorkerLoopResult,
  WorkerLoopError,
  workerContinuationSegmentLimit,
} from "./worker-loop.js";
import {
  scopeViolations,
  scopeViolationSummary,
  WorkerWorkspaceManager,
} from "./worker-workspaces.js";

const clarificationQuestionSchema = z.object({
  prompt: z.string().min(1).max(600),
  consequenceIfWrong: z.string().min(1).max(1_000),
  options: z.array(z.object({
    label: z.string().min(1).max(160),
    resolutionText: z.string().min(1).max(1_000),
    delegate: z.boolean().default(false),
  }).strict()).min(2).max(6),
}).strict();

const intentSchema = z.object({
  goal: z.string().min(1).max(8_000),
  requirements: z.array(z.string().min(1).max(4_000)).min(1).max(100),
  assumptions: z.array(z.string().max(4_000)).max(100),
  nonGoals: z.array(z.string().max(4_000)).max(100),
  architectureDecisions: z.array(z.string().max(4_000)).max(100),
  // Strings remain accepted for compatibility with the frozen contract and
  // older planner responses. Rich question objects are serialized back into
  // those strings at the boundary for the inline clarification UI.
  materialQuestions: z.array(
    z.union([z.string().max(4_000), clarificationQuestionSchema]),
  ).max(50),
  manualExpectations: z.array(z.string().max(4_000)).max(100),
  estimate: z.object({
    inputTokenLow: z.number().int().nonnegative(),
    inputTokenHigh: z.number().int().nonnegative(),
    outputTokenLow: z.number().int().nonnegative(),
    outputTokenHigh: z.number().int().nonnegative(),
    estimatedUsdLow: z.number().nonnegative().nullable(),
    estimatedUsdHigh: z.number().nonnegative().nullable(),
    pricingStatus: z.enum(["configured", "unknown"]),
    assumptions: z.array(z.string().max(2_000)).max(30),
  }),
}).strict();

function normalizedAllowedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function allowedPathProblem(value: string): string | null {
  const normalized = normalizedAllowedPath(value);
  if (!normalized) return "Allowed paths must not be empty";
  if (normalized.startsWith("/")) return "Allowed paths must be repository-relative";
  if (normalized.split("/").includes("..")) return "Allowed paths must not contain '..'";
  if (isProtectedEnvironmentPath(normalized)) {
    return "Protected environment files are not allowed; use .env.example, .env.sample, or .env.template for non-secret configuration templates";
  }
  return null;
}

const allowedPathSchema = z.string().min(1).max(500).superRefine((value, context) => {
  const problem = allowedPathProblem(value);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

const planSchema = (
  maximumEstimatedCalls: number,
  maximumEstimatedArkTurns: number,
  maximumTaskArkTurns: number,
  maximumTaskInputTokens: number,
) => z.object({
  coupling: z.preprocess((value) => typeof value === "string" ? value.toLowerCase() : value, z.enum(["low", "medium", "high"])),
  estimatedCalls: z.coerce.number().int().positive().max(maximumEstimatedCalls),
  estimatedArkApiTurns: z.coerce.number().int().positive().max(maximumEstimatedArkTurns)
    .default(Math.min(10, maximumEstimatedArkTurns)),
  estimatedContextTokens: z.coerce.number().int().nonnegative(),
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    objective: z.string().min(1).max(4_000),
    dependsOn: z.array(z.coerce.number().int().nonnegative()).max(50).default([]),
    allowedPaths: z.array(allowedPathSchema).min(1).max(100),
    acceptanceCriterionIds: z.array(z.string().max(200)).max(100).default([]),
    requiredArtifactIds: z.array(z.string().max(200)).max(100).default([]),
    estimatedArkApiTurns: z.coerce.number().int().positive().optional(),
    estimatedInputTokens: z.coerce.number().int().positive().optional(),
  })).min(1).max(20),
  acceptanceTests: z.array(plannedAcceptanceTestSchema).max(200).default([]),
}).strict().superRefine((value, context) => {
  const writeConflicts = value.tasks.length > 1
    ? overlappingWriteScopeConflicts(value.tasks)
    : [];
  if (writeConflicts.length) {
    const examples = writeConflicts.slice(0, 8).map((conflict) =>
      `tasks[${conflict.leftTaskIndex}] ${JSON.stringify(conflict.leftPath)} conflicts with tasks[${conflict.rightTaskIndex}] ${JSON.stringify(conflict.rightPath)}`
    ).join("; ");
    const omitted = writeConflicts.length > 8 ? `; +${writeConflicts.length - 8} more conflicts` : "";
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: `Worker allowedPaths overlap: ${examples}${omitted}. Give every writable path exactly one owner. Remove the parent path from one task, use narrower exclusive paths, or collapse inseparable work into one task. Dependencies do not make overlapping write ownership safe.`,
    });
  }
  const defaultTurns = Math.ceil(value.estimatedArkApiTurns / value.tasks.length);
  const contextPerTask = Math.max(1, Math.ceil(value.estimatedContextTokens / value.tasks.length));
  value.tasks.forEach((task, index) => {
    const estimatedTurns = task.estimatedArkApiTurns ?? defaultTurns;
    const estimatedInput = task.estimatedInputTokens ?? contextPerTask * estimatedTurns;
    if (estimatedTurns > maximumTaskArkTurns) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index, "estimatedArkApiTurns"],
        message: `Task requires about ${estimatedTurns} Ark turns but its ${maximumTaskArkTurns}-turn continuation capacity is smaller. Split it into dependency-ordered tasks with exclusive paths.`,
      });
    }
    if (estimatedInput > maximumTaskInputTokens) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index, "estimatedInputTokens"],
        message: `Task requires about ${estimatedInput} cumulative input tokens but its ${maximumTaskInputTokens}-token continuation capacity is smaller. Split it into bounded tasks.`,
      });
    }
  });
  const explicitTaskTurns = value.tasks.reduce(
    (total, task) => total + (task.estimatedArkApiTurns ?? 0),
    0,
  );
  if (
    value.tasks.every((task) => task.estimatedArkApiTurns !== undefined) &&
    explicitTaskTurns > value.estimatedArkApiTurns
  ) {
    context.addIssue({
      code: "custom",
      path: ["estimatedArkApiTurns"],
      message: "Top-level estimatedArkApiTurns must cover the sum of all task estimates plus verification and recovery.",
    });
  }
});

const MAXIMUM_PLANNER_RESPONSE_CALLS = 2;
const MAXIMUM_PLANNER_ARK_TURN_RESERVE = 4;
const MAXIMUM_VERIFIER_TRANSPORT_RETRIES = 1;
export type VerificationProfileName = "fast" | "standard" | "complex";

export interface AdaptiveVerificationProfile {
  name: VerificationProfileName;
  maxArkApiTurns: number;
  maxInputTokens: number;
  maxToolCalls: number;
  timeoutMs: number;
  maxShellInvocations: number;
  fileEvidenceLimit: number;
  fileSummaryCharacters: number;
  procedureCharacters: number;
  expectedOutcomeCharacters: number;
  promptCharacters: number;
}

const VERIFICATION_PROFILES: Record<VerificationProfileName, AdaptiveVerificationProfile> = {
  fast: {
    name: "fast",
    maxArkApiTurns: 1,
    maxInputTokens: 25_000,
    maxToolCalls: 1,
    timeoutMs: 60_000,
    maxShellInvocations: 0,
    fileEvidenceLimit: 40,
    fileSummaryCharacters: 180,
    procedureCharacters: 600,
    expectedOutcomeCharacters: 350,
    promptCharacters: 28_000,
  },
  standard: {
    name: "standard",
    maxArkApiTurns: 4,
    maxInputTokens: 75_000,
    maxToolCalls: 3,
    timeoutMs: 150_000,
    maxShellInvocations: 2,
    fileEvidenceLimit: 120,
    fileSummaryCharacters: 300,
    procedureCharacters: 900,
    expectedOutcomeCharacters: 500,
    promptCharacters: 48_000,
  },
  complex: {
    name: "complex",
    maxArkApiTurns: 6,
    maxInputTokens: 120_000,
    maxToolCalls: 5,
    timeoutMs: 240_000,
    maxShellInvocations: 3,
    fileEvidenceLimit: 200,
    fileSummaryCharacters: 400,
    procedureCharacters: 1_200,
    expectedOutcomeCharacters: 700,
    promptCharacters: 64_000,
  },
};

export function selectAdaptiveVerificationProfile(input: {
  fileCount: number;
  totalBytes: number;
  taskCount: number;
  automatedTestCount: number;
  hasBuildOrRuntimeManifest: boolean;
  recoveryRound: number;
}): AdaptiveVerificationProfile {
  const fast = input.fileCount <= 20 &&
    input.totalBytes <= 500_000 &&
    input.taskCount <= 2 &&
    input.automatedTestCount <= 20 &&
    !input.hasBuildOrRuntimeManifest &&
    input.recoveryRound === 0;
  if (fast) return VERIFICATION_PROFILES.fast;
  const standard = input.fileCount <= 200 &&
    input.totalBytes <= 15_000_000 &&
    input.taskCount <= 8 &&
    input.automatedTestCount <= 40;
  return standard ? VERIFICATION_PROFILES.standard : VERIFICATION_PROFILES.complex;
}

function consumedModelCalls(orchestration: Orchestration): number {
  return Object.values(orchestration.usage.byRole).reduce(
    (total, usage) => total + (usage?.modelCalls ?? 0),
    0,
  );
}

function consumedArkApiTurns(orchestration: Orchestration): number {
  return orchestration.usage.totalArkApiTurns ?? Object.values(orchestration.usage.byRole).reduce(
    (total, usage) => total + (usage?.arkApiTurns ?? 0),
    0,
  );
}

const acceptanceVerificationSchema = z.object({
  results: z.array(z.object({
    testId: z.string().min(1).max(200),
    status: z.enum(["passed", "failed"]),
    evidence: z.string().min(1).max(8_000),
  }).strict()).max(200),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.results.forEach((result, index) => {
    if (seen.has(result.testId)) {
      context.addIssue({
        code: "custom",
        path: ["results", index, "testId"],
        message: `Duplicate verification result for testId ${result.testId}`,
      });
    }
    seen.add(result.testId);
  });
});

function boundedJson(value: unknown, maximumCharacters: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maximumCharacters) return serialized;
  let previewLength = Math.max(0, maximumCharacters - 200);
  while (previewLength > 0) {
    const bounded = JSON.stringify({
      truncated: true,
      originalCharacters: serialized.length,
      preview: serialized.slice(0, previewLength),
    });
    if (bounded.length <= maximumCharacters) return bounded;
    previewLength = Math.floor(previewLength * 0.8);
  }
  return JSON.stringify({ truncated: true, originalCharacters: serialized.length });
}

const conflictSchema = z.object({ content: z.string().max(200_000) }).strict();
const diagnosisSchema = z.object({
  classification: z.enum([
    "implementation-bug", "missing-context", "stale-dependency", "weak-model",
    "invalid-plan", "ambiguous-contract", "suspected-bad-check", "budget-exhaustion",
  ]),
  outcome: z.enum(["stop", "needs-user"]),
  reason: z.string().min(1).max(4_000),
}).strict();

function serializeMaterialQuestion(
  question: string | z.infer<typeof clarificationQuestionSchema>,
): string {
  return typeof question === "string"
    ? question
    : JSON.stringify({
        prompt: question.prompt,
        consequenceIfWrong: question.consequenceIfWrong,
        options: question.options,
      });
}

export interface EngineDriverOptions {
  runner: AgentRunner;
  models: RoleModelConfiguration;
  runtimeHomeRoot: string;
  tempRoot: string;
  archiveRoot: string;
  protectedEvaluatorRoot: string;
  verificationChecks?: readonly TrustedVerificationCheck[];
  allowedVerificationExecutables?: ReadonlySet<string>;
  cleanupPolicy?: "clean" | "archive" | "retain";
  id?: () => string;
  clock?: () => Date;
  modelCallTimeoutMs?: number;
  modelTransportMaxRetries?: number;
  unrestrictedMode?: boolean;
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

const addUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  arkApiTurns: (left.arkApiTurns ?? 0) + (right.arkApiTurns ?? 0),
  toolCalls: (left.toolCalls ?? 0) + (right.toolCalls ?? 0),
  streamRetries: (left.streamRetries ?? 0) + (right.streamRetries ?? 0),
  peakContextTokens: Math.max(left.peakContextTokens ?? 0, right.peakContextTokens ?? 0),
});

type IncompleteExecutionOutcome = Exclude<ExecutionOutcome, { kind: "completed" }>;
type IntegrationGateResult =
  | { kind: "verified"; candidate: IntegrationCandidate }
  | { kind: "outcome"; outcome: IncompleteExecutionOutcome };

function safeAllowedPath(value: string): string {
  const problem = allowedPathProblem(value);
  if (problem) throw new Error(`Planner produced unsafe allowed path: ${value} (${problem})`);
  return normalizedAllowedPath(value);
}

function broadWriteScope(value: string): string {
  const normalized = normalizedAllowedPath(value);
  if (normalized === ".") return ".";
  return normalized.split("/")[0]!;
}

export function mergeTasksByBroadWriteScope(
  tasks: OrchestrationTask[],
): OrchestrationTask[] {
  if (tasks.length < 2) {
    return tasks.map((task) => ({
      ...task,
      allowedPaths: [...new Set(task.allowedPaths.map(broadWriteScope))],
    }));
  }
  const parents = tasks.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const scopes = tasks.map((task) => new Set(task.allowedPaths.map(broadWriteScope)));
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      if (
        scopes[left]!.has(".") ||
        scopes[right]!.has(".") ||
        [...scopes[left]!].some((scope) => scopes[right]!.has(scope))
      ) {
        union(left, right);
      }
    }
  }
  const grouped = new Map<number, number[]>();
  tasks.forEach((_, index) => {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), index]);
  });
  const groupForTaskId = new Map<string, number>();
  for (const [root, indexes] of grouped) {
    for (const index of indexes) groupForTaskId.set(tasks[index]!.id, root);
  }
  const groupId = new Map<number, string>();
  for (const [root, indexes] of grouped) groupId.set(root, tasks[indexes[0]!]!.id);

  return [...grouped.entries()]
    .sort((left, right) => left[1][0]! - right[1][0]!)
    .map(([root, indexes]) => {
      const members = indexes.map((index) => tasks[index]!);
      const allowedPaths = [...new Set(members.flatMap((task) => task.allowedPaths.map(broadWriteScope)))];
      const dependsOn = [...new Set(members.flatMap((task) => task.dependsOn)
        .map((dependency) => groupForTaskId.get(dependency))
        .filter((dependencyRoot): dependencyRoot is number => dependencyRoot !== undefined && dependencyRoot !== root)
        .map((dependencyRoot) => groupId.get(dependencyRoot)!))];
      return {
        ...members[0]!,
        title: members.length === 1
          ? members[0]!.title
          : `Combined ${allowedPaths.join(", ")} implementation`.slice(0, 500),
        objective: members.map((task) => task.objective).join("; ").slice(0, 12_000),
        status: dependsOn.length ? "blocked" as const : "ready" as const,
        dependsOn,
        allowedPaths,
        acceptanceCriterionIds: [...new Set(members.flatMap((task) => task.acceptanceCriterionIds))],
        requiredArtifactIds: [...new Set(members.flatMap((task) => task.requiredArtifactIds))],
        observedArtifactVersions: {},
        attemptCount: 0,
      };
    });
}

function resultsForSupervisor(tasks: OrchestrationTask[]) {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    objective: task.objective,
    allowedPaths: task.allowedPaths,
    acceptanceCriterionIds: task.acceptanceCriterionIds,
  }));
}

function hasExistingRegressionInfrastructure(map: DetailedApplicationMap): boolean {
  return map.entries.some((entry) => {
    const file = entry.path.toLowerCase();
    return (
      /(^|\/)(?:__tests__|tests?|specs?)(\/|$)/.test(file) ||
      /\.(?:test|spec)\.[^/]+$/.test(file) ||
      /(^|\/)(?:package\.json|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|makefile|justfile|deno\.jsonc?)$/.test(file) ||
      /(^|\/)(?:vitest|jest|playwright|cypress|karma|ava|mocha)\.config\.[^/]+$/.test(file) ||
      file.startsWith(".github/workflows/")
    );
  });
}

export class ContextAwareExecutionDriver implements OrchestrationExecutionDriver {
  private readonly maps = new Map<string, DetailedApplicationMap>();
  private readonly activeRoles = new Map<string, RoleExecutor>();
  private readonly workspaces: WorkerWorkspaceManager;
  private readonly integrator: DeterministicIntegrator;
  private readonly verification: VerificationService;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly cleanupPolicy: "clean" | "archive" | "retain";

  constructor(private readonly options: EngineDriverOptions) {
    this.newId = options.id ?? randomUUID;
    this.now = options.clock ?? (() => new Date());
    this.cleanupPolicy = options.cleanupPolicy ?? "archive";
    this.workspaces = new WorkerWorkspaceManager(options.tempRoot, options.archiveRoot);
    this.integrator = new DeterministicIntegrator(options.tempRoot);
    this.verification = new VerificationService(
      options.protectedEvaluatorRoot,
      options.verificationChecks ?? [],
      options.allowedVerificationExecutables ?? new Set(),
      this.newId,
    );
  }

  async elaborateIntent(
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<{ draft: IntentDraft; estimate: CostEstimate }> {
    const roles = this.roles(input.orchestrationId, sink);
    const intentMap = await buildApplicationMap(
      input.workspacePath,
      input.orchestrationId,
      0,
      this.now(),
    );
    const result = await roles.structured(
      {
        orchestrationId: input.orchestrationId,
        agentId: input.agentId,
        taskId: null,
        role: "planner",
        workspacePath: input.workspacePath,
        sandboxMode: "read-only",
        signal,
        maxArkApiTurns: 2,
        maxInputTokens: 60_000,
        maxToolCalls: 1,
        timeoutMs: 60_000,
        prompt: [
          "Elaborate the user's intent without editing files. Return only JSON.",
          `Requested mode: ${input.requestedMode}`,
          `Hard budget: ${JSON.stringify(input.budget)}`,
          `User prompt: ${input.prompt}`,
          `Deterministic workspace summary: ${JSON.stringify({
            summary: intentMap.summary.summary,
            files: intentMap.entries.slice(0, 120).map((entry) => ({ path: entry.path, summary: entry.summary })),
          })}`,
          "Use only the supplied request and deterministic workspace summary. Do not call tools or inspect files during intent elaboration.",
          "Return goal, requirements, assumptions, nonGoals, architectureDecisions, materialQuestions, manualExpectations, and estimate.",
          "Each materialQuestions item should be an object with prompt, consequenceIfWrong, and 2-6 options.",
          "Each option needs label, resolutionText, and delegate. Include one delegate=true recommended default.",
          "Only ask when the choice materially changes scope, architecture, safety, public interfaces, acceptance, or cost.",
          "For a small, reversible local task, make conservative reasonable assumptions and return no material questions instead of creating a long clarification phase.",
          "Keep every returned section mutually consistent. Requirements, assumptions, non-goals, architecture decisions, and manual expectations must not contradict one another.",
          "When the user prompt is a clarification reconciliation pass, apply every resolution throughout the entire intent, remove stale conditional statements, and return no material questions.",
        ].join("\n"),
      },
      intentSchema,
    );
    const createdAt = this.now().toISOString();
    return {
      draft: {
        id: this.newId(),
        orchestrationId: input.orchestrationId,
        revision: 1,
        goal: result.value.goal,
        requirements: result.value.requirements,
        assumptions: result.value.assumptions,
        nonGoals: result.value.nonGoals,
        architectureDecisions: result.value.architectureDecisions,
        materialQuestions: result.value.materialQuestions.map(serializeMaterialQuestion),
        manualExpectations: result.value.manualExpectations,
        createdAt,
      },
      estimate: result.value.estimate,
    };
  }

  async plan(input: PlanInput, sink: OrchestrationSink, signal: AbortSignal): Promise<PlanResult> {
    const alreadyConsumedModelCalls = consumedModelCalls(input.orchestration);
    const availableExecutionModelCalls = Math.min(
      500,
      Math.floor(
        input.orchestration.budget.maxModelCalls
          - alreadyConsumedModelCalls
          - MAXIMUM_PLANNER_RESPONSE_CALLS,
      ),
    );
    const alreadyConsumedArkApiTurns = consumedArkApiTurns(input.orchestration);
    const availableExecutionArkApiTurns = Math.max(
      0,
      (input.orchestration.budget.maxArkApiTurns ?? 150) -
        alreadyConsumedArkApiTurns -
        MAXIMUM_PLANNER_ARK_TURN_RESERVE,
    );
    if (availableExecutionModelCalls < 1) {
      throw new Error(
        "No model-call budget remains for execution after reserving the bounded planning call",
      );
    }
    if (availableExecutionArkApiTurns < 1) {
      throw new Error("No Ark-turn budget remains for execution after reserving the bounded planning pass");
    }
    const maximumWorkerSegments = workerContinuationSegmentLimit(input.orchestration.budget);
    const maximumTaskArkTurns =
      (input.orchestration.budget.maxArkApiTurnsPerExecution ?? 15) * maximumWorkerSegments;
    const maximumTaskInputTokens =
      (input.orchestration.budget.maxInputTokensPerExecution ?? 250_000) * maximumWorkerSegments;
    const map = await buildApplicationMap(input.workspacePath, input.orchestration.id, 1, this.now());
    this.maps.set(input.orchestration.id, map);
    await sink.recordApplicationMap(map.summary);
    const roles = this.roles(input.orchestration.id, sink);
    const compactContract = {
      version: input.contract.version,
      goal: input.contract.intent.goal,
      requirements: input.contract.intent.requirements,
      architectureDecisions: input.contract.intent.architectureDecisions,
      nonGoals: input.contract.intent.nonGoals,
      criteria: input.contract.criteria.map(({ id, kind, description, verification }) => ({
        id,
        kind,
        description,
        verification,
      })),
    };
    const result = await roles.structured(
      {
        orchestrationId: input.orchestration.id,
        agentId: input.orchestration.agentId,
        taskId: null,
        role: "planner",
        workspacePath: input.workspacePath,
        sandboxMode: "read-only",
        signal,
        maxArkApiTurns: 2,
        maxInputTokens: 100_000,
        maxToolCalls: 1,
        timeoutMs: 180_000,
        prompt: [
          "Create a bounded coding plan for the explicitly confirmed contract. Do not edit files.",
          ...(this.options.unrestrictedMode
            ? [
                "Unrestricted full-application mode is active. Maximize safe parallelism: assign independent top-level areas such as frontend/, backend/, infrastructure/, and root documentation/configuration to separate tasks that can run simultaneously. Use broad directory allowedPaths instead of enumerating files. Never create two tasks that write the same top-level directory. Add dependsOn only for a genuine data or interface dependency; do not serialize independent frontend and backend scaffolding.",
                "Keep acceptance verification compact: cover multiple related criteria in the same end-to-end test where one procedure can prove them together. Return at most 6 meaningful acceptance tests. Do not create one test per criterion; one end-to-end check should cover all criteria it can prove.",
              ]
            : []),
          "The complete planning evidence is supplied below. Do not call tools or independently inspect the workspace during planning.",
          `Compact contract: ${JSON.stringify(compactContract)}`,
          `Application map: ${JSON.stringify({ summary: map.summary, entries: map.entries.map((entry) => ({ path: entry.path, imports: entry.imports, exports: entry.exports, summary: entry.summary })) })}`,
          `Total model-call budget: ${input.orchestration.budget.maxModelCalls}`,
          `Model calls already consumed before this planning response: ${alreadyConsumedModelCalls}`,
          `Model calls reserved for this response and one possible format-repair response: ${MAXIMUM_PLANNER_RESPONSE_CALLS}`,
          `Maximum future model calls this plan may estimate: ${availableExecutionModelCalls}`,
          `Completed Ark turns already consumed: ${alreadyConsumedArkApiTurns}`,
          `Maximum future Ark turns this plan may estimate: ${availableExecutionArkApiTurns}`,
          `Maximum continuation segments per worker task: ${maximumWorkerSegments}`,
          `Maximum cumulative Ark turns one worker task may require across its fresh checkpoint segments: ${maximumTaskArkTurns}`,
          `Maximum cumulative input tokens one worker task may require across its fresh checkpoint segments: ${maximumTaskInputTokens}`,
          "estimatedCalls counts top-level Codex executions after planning. estimatedArkApiTurns counts the underlying model turns inside those executions, including worker implementation, verification, supervision, retries, and recovery.",
          `Return estimatedCalls no greater than ${availableExecutionModelCalls}. Plan the complete confirmed scope within that allowance by minimizing handoffs, combining tightly coupled work, and preferring deterministic tools and checks where they do not require a model call. Do not drop or weaken confirmed requirements to meet the budget.`,
          `Return estimatedArkApiTurns no greater than ${availableExecutionArkApiTurns}. Prefer several bounded non-overlapping tasks over one oversized worker. Assign shared root configuration files to one foundation task and make dependent tasks consume that result instead of sharing write ownership.`,
          "Give every package manifest, lockfile, entry scaffold, migration, seed, and generated database path exactly one explicit owner. A task that may run install, build, migration, or seed commands must either own every repository file those commands can legitimately change or use flags that keep those files unchanged. Cache and temporary output are never task deliverables.",
          "Before returning JSON, compare every allowedPaths entry across every pair of tasks. A path conflicts with an identical path, its parent, or its child. Dependencies do not permit overlap. If clean exclusive ownership is impossible, return one integrated task containing the complete scope instead of multiple conflicting tasks.",
          "Keep task objectives concise and implementation-focused. Do not repeat the full contract. Give each task its own estimatedArkApiTurns and estimatedInputTokens. If a task exceeds its continuation capacity, split it before returning the plan.",
          "Also create a compact protected acceptance-test plan with at most 6 tests. Cover every confirmed criterion, important edge/failure cases, scope constraints, runtime behavior, and existing regressions by grouping related criteria into the same end-to-end procedure. Test procedures must be concrete and non-destructive. Use manual scope only when automation cannot reasonably decide the result.",
          "Classify each acceptance test as verificationPhase release-gate or post-release. A release-gate check must be independently verifiable from the integrated candidate before publication. Anything that observes the eventual assistant reply, a user notification, deployment, publication, or another effect that can only happen after final verification is post-release. Never make a release-gate check depend on a post-release effect.",
          "Post-release checks are recorded as deferred obligations but are never sent to the release verifier and never block publication.",
          "When the contract restricts all edits to one explicit file, return exactly one task covering that file.",
          "Protect configuration secrets: allowedPaths must never include .env, .env.local, .env.production, or any other real environment file at any directory depth. Non-secret templates named exactly .env.example, .env.sample, or .env.template are allowed.",
          "Return this exact JSON shape with no additional task fields:",
          '{"coupling":"low|medium|high","estimatedCalls":8,"estimatedArkApiTurns":40,"estimatedContextTokens":12000,"tasks":[{"title":"short title","objective":"bounded objective","dependsOn":[],"allowedPaths":["repository/relative/path"],"acceptanceCriterionIds":["exact confirmed criterion ID"],"requiredArtifactIds":[],"estimatedArkApiTurns":12,"estimatedInputTokens":120000}],"acceptanceTests":[{"id":"stable-id","title":"observable behavior","criterionIds":["exact confirmed criterion ID"],"category":"functional|architectural|scope|runtime|regression|manual","scope":"protected|global|manual","verificationPhase":"release-gate|post-release","procedure":"specific independent verification steps","expectedOutcome":"precise pass condition"}]}',
          "dependsOn contains zero-based indexes of earlier tasks only. allowedPaths must be repository-relative, must never begin with /workspace or contain '..', and must follow the environment-file rule above. Use exact criterion IDs from the confirmed contract.",
        ].join("\n").slice(0, 150_000),
      },
      planSchema(
        availableExecutionModelCalls,
        availableExecutionArkApiTurns,
        maximumTaskArkTurns,
        maximumTaskInputTokens,
      ),
    );
    const acceptanceTests = consolidateAcceptanceTests(
      comprehensiveAcceptanceTests(result.value.acceptanceTests, input.contract),
    );
    await this.verification.saveAcceptancePlan({
      orchestrationId: input.orchestration.id,
      contractVersion: input.contract.version,
      generatedBy: "planner",
      tests: acceptanceTests,
    });
    for (const test of acceptanceTests) {
      await sink.publishArtifact({
        id: this.newId(),
        orchestrationId: input.orchestration.id,
        producerTaskId: "planner",
        kind: "decision",
        name: `Planner acceptance test: ${test.id}`,
        version: input.contract.version,
        payload: JSON.stringify({
          ...test,
          procedure: test.procedure.slice(0, 2_500),
          expectedOutcome: test.expectedOutcome.slice(0, 1_500),
        }),
        createdAt: this.now().toISOString(),
      });
    }
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: result.executionId,
      type: "acceptance-plan-created",
      actorRole: "planner",
      modelId: result.actualModelId,
      summary: "Planner created the protected acceptance-test plan",
      metadata: {
        testCount: acceptanceTests.length,
        coveredCriteria: new Set(acceptanceTests.flatMap((test) => test.criterionIds)).size,
        contractVersion: input.contract.version,
      },
    });
    const route = selectRoute({
      requestedMode: input.orchestration.requestedMode,
      taskCount: result.value.tasks.length,
      changedAreaCount: new Set(result.value.tasks.flatMap((task) => task.allowedPaths.map((entry) => entry.split("/")[0]))).size,
      hasOverlappingWriteScopes: tasksHaveOverlappingWriteScopes(result.value.tasks),
      coupling: result.value.coupling,
      estimatedCalls: result.value.estimatedCalls,
      estimatedContextTokens: result.value.estimatedContextTokens,
      budget: {
        ...input.orchestration.budget,
        maxModelCalls: availableExecutionModelCalls,
      },
    });
    const ids = result.value.tasks.map(() => this.newId());
    const criterionIds = new Set(input.contract.criteria.map((criterion) => criterion.id));
    let tasks: OrchestrationTask[] = result.value.tasks.map((task, index) => {
      const dependsOn = task.dependsOn.map((dependency) => {
        if (dependency >= index || !ids[dependency]) throw new Error("Plan contains an invalid or cyclic dependency");
        return ids[dependency]!;
      });
      const referenced = task.acceptanceCriterionIds.filter((id) => criterionIds.has(id));
      return {
        id: ids[index]!,
        orchestrationId: input.orchestration.id,
        title: task.title,
        objective: task.objective,
        status: dependsOn.length ? "blocked" : "ready",
        dependsOn,
        allowedPaths: [...new Set(task.allowedPaths.map(safeAllowedPath))],
        acceptanceCriterionIds: referenced.length ? referenced : [...criterionIds],
        requiredArtifactIds: [...new Set(task.requiredArtifactIds)],
        observedArtifactVersions: {},
        applicationMapVersion: map.summary.version,
        attemptCount: 0,
      };
    });
    if (this.options.unrestrictedMode) {
      tasks = mergeTasksByBroadWriteScope(tasks);
    } else if (route.selectedMode === "direct" && tasks.length > 1) {
      const combinedObjective = tasks
        .map((task) => task.objective.trim())
        .filter((objective, index, values) => values.indexOf(objective) === index)
        .join("; ")
        .slice(0, 6_000);
      tasks = [{
        id: this.newId(),
        orchestrationId: input.orchestration.id,
        title: "Direct confirmed execution",
        objective: combinedObjective || input.contract.intent.goal,
        status: "ready",
        dependsOn: [],
        allowedPaths: [...new Set(tasks.flatMap((task) => task.allowedPaths))],
        acceptanceCriterionIds: [...new Set(tasks.flatMap((task) => task.acceptanceCriterionIds))],
        requiredArtifactIds: [...new Set(tasks.flatMap((task) => task.requiredArtifactIds))],
        observedArtifactVersions: {},
        applicationMapVersion: map.summary.version,
        attemptCount: 0,
      }];
    }
    const selectedMode = this.options.unrestrictedMode
      ? tasks.length > 1 ? "multi-worker" as const : "one-worker" as const
      : route.selectedMode;
    for (const task of tasks) await sink.upsertTask(task);
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: result.executionId,
      type: "route-decision",
      actorRole: "planner",
      modelId: result.actualModelId,
      summary: route.reason,
      metadata: {
        selectedMode,
        taskCount: tasks.length,
        estimatedCalls: result.value.estimatedCalls,
        estimatedArkApiTurns: result.value.estimatedArkApiTurns,
        availableExecutionModelCalls,
        availableExecutionArkApiTurns,
        maximumTaskArkTurns,
        maximumTaskInputTokens,
        alreadyConsumedModelCalls,
        reservedPlanningModelCalls: MAXIMUM_PLANNER_RESPONSE_CALLS,
      },
    });
    return {
      selectedMode,
      routeReason: this.options.unrestrictedMode
        ? tasks.length > 1
          ? "Unrestricted mode runs independent top-level write scopes concurrently"
          : "Unrestricted mode merged overlapping write scopes into one safe owner"
        : route.reason,
      tasks,
      applicationMap: map.summary,
    };
  }

  async execute(input: ExecuteInput, sink: OrchestrationSink, signal: AbortSignal): Promise<ExecutionOutcome> {
    const roles = this.roles(input.orchestration.id, sink);
    const map = this.maps.get(input.orchestration.id) ??
      (await buildApplicationMap(input.workspacePath, input.orchestration.id, input.plan.applicationMap.version, this.now()));
    this.maps.set(input.orchestration.id, map);
    const broker = new ContextBroker(input.workspacePath, input.orchestration.budget.maxContextExpansionsPerTask);
    const artifacts = new ArtifactRegistry(sink);
    const loop = new BoundedWorkerLoop(
      roles,
      sink,
      this.verification,
      this.workspaces,
      broker,
      artifacts,
      this.newId,
    );
    const results: WorkerLoopResult[] = [];
    try {
      if (input.plan.selectedMode === "direct") {
        results.push(await this.runDirect(input, sink, roles, signal));
      } else {
        const remaining = new Set(input.plan.tasks.map((task) => task.id));
        while (remaining.size) {
          if (signal.aborted) return { kind: "cancelled", reason: "Cancelled before worker batch" };
          const ready = input.plan.tasks.filter(
            (task) => remaining.has(task.id) && task.dependsOn.every((dependency) => !remaining.has(dependency)),
          );
          if (!ready.length) throw new Error("Plan dependency graph cannot make progress");
          for (const task of ready) {
            if (task.status === "stale" || task.requiredArtifactIds.length) await artifacts.refresh(task);
            task.status = "ready";
            await sink.upsertTask(task);
          }
          const batch = await Promise.all(
            ready.map((task) =>
              loop.run({
                orchestration: input.orchestration,
                contract: input.contract,
                task,
                tasks: input.plan.tasks,
                map,
                mainWorkspacePath: input.workspacePath,
                signal,
                deterministicPreflight: true,
              }),
            ),
          );
          results.push(...batch);
          for (const task of ready) remaining.delete(task.id);
        }
      }

      const recovered = await this.integrateAndVerify(
        input,
        sink,
        roles,
        results,
        signal,
      );
      if (recovered.kind !== "verified") {
        await this.cleanup(results, "archive");
        if (recovered.outcome.kind !== "verification-failed") {
          await this.workspaces.cleanupOrchestration(input.orchestration.id, "clean");
        }
        return recovered.outcome;
      }
      const candidate = recovered.candidate;
      const published = await this.integrator.publish(candidate, input.workspacePath);
      const refreshed = await buildApplicationMap(
        input.workspacePath,
        input.orchestration.id,
        map.summary.version + 1,
        this.now(),
      );
      this.maps.set(input.orchestration.id, refreshed);
      await sink.recordApplicationMap(refreshed.summary);
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: "verified-publish",
        actorRole: "control-plane",
        modelId: null,
        summary: "Verified changes published to the Agent workspace",
        metadata: { fileCount: published.length, applicationMapVersion: refreshed.summary.version },
      });
      await this.integrator.cleanup(candidate);
      await this.cleanup(results, this.cleanupPolicy);
      await this.workspaces.cleanupOrchestration(input.orchestration.id, "clean");
      return {
        kind: "completed",
        finalOutput: results.map((result) => `${result.task.title}: ${result.summary}`).join("\n"),
      };
    } catch (error) {
      await this.cleanup(results, "archive").catch(() => undefined);
      await this.workspaces.cleanupOrchestration(input.orchestration.id, "archive").catch(() => undefined);
      if (signal.aborted) return { kind: "cancelled", reason: "Orchestration cancelled" };
      if (error instanceof WorkerLoopError) {
        await sink.recordEvent({
          orchestrationId: input.orchestration.id,
          taskId: error.packet.taskId,
          executionId: null,
          type: "failure-escalation",
          actorRole: "control-plane",
          modelId: null,
          summary: "Bounded worker failure compressed for planner diagnosis",
          metadata: { attemptCount: error.packet.attemptCount, classification: classifyFailure(error.packet) },
        });
        if (error.supervisorDecision) {
          if (error.supervisorDecision.action === "needs-user") {
            return {
              kind: "needs-user",
              amendment: this.amendment(
                input,
                error.supervisorDecision.reason,
                error.supervisorDecision.userQuestion ?? error.supervisorDecision.reason,
              ),
            };
          }
          return { kind: "failed", reason: error.supervisorDecision.reason };
        }
        if (isInternalInfrastructureFailure(error.packet.lastError)) {
          return {
            kind: "failed",
            reason: `Automatic recovery from an internal Runtime launch failure was exhausted: ${error.packet.lastError}`,
          };
        }
        try {
          const diagnosis = await roles.structured(
            {
              orchestrationId: input.orchestration.id,
              agentId: input.orchestration.agentId,
              taskId: error.packet.taskId,
              role: "planner",
              workspacePath: input.workspacePath,
              sandboxMode: "read-only",
              signal,
              prompt: `Diagnose this compact failure packet without requesting transcripts. Return JSON classification, outcome, reason.\n${JSON.stringify(error.packet)}`,
            },
            diagnosisSchema,
          );
          if (diagnosis.value.outcome === "needs-user") {
            return {
              kind: "needs-user",
              amendment: this.amendment(input, diagnosis.value.reason, diagnosis.value.reason),
            };
          }
          return { kind: "failed", reason: diagnosis.value.reason };
        } catch (diagnosisError) {
          const reason = diagnosisError instanceof Error ? diagnosisError.message : String(diagnosisError);
          return /budget denied/i.test(reason)
            ? { kind: "budget-exhausted", reason }
            : { kind: "failed", reason: error.packet.lastError };
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      return /budget denied|budget exhausted/i.test(reason)
        ? { kind: "budget-exhausted", reason }
        : { kind: "failed", reason };
    } finally {
      this.activeRoles.delete(input.orchestration.id);
    }
  }

  async cancel(orchestrationId: string): Promise<boolean> {
    return (await this.activeRoles.get(orchestrationId)?.cancelOrchestration(orchestrationId)) ?? false;
  }

  async retryVerification(
    input: ExecuteInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
    verificationRound: number,
  ): Promise<ExecutionOutcome> {
    const roles = this.roles(input.orchestration.id, sink);
    try {
      const candidate = await this.integrator.loadRetained(
        input.orchestration.id,
        input.workspacePath,
      );
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: "verification-only-retry-started",
        actorRole: "control-plane",
        modelId: null,
        summary: "Retrying verification against the retained integrated candidate",
        metadata: { verificationRound, retainedFileCount: candidate.changes.changedFiles.length },
      });
      const deterministic = await this.verification.run(
        input.orchestration.id,
        null,
        candidate.path,
        ["protected", "global", "manual"],
        sink,
        signal,
        `manual-retry-${verificationRound}`,
      );
      const planned = await this.runPlannedAcceptanceVerification(
        input,
        roles,
        candidate.path,
        sink,
        signal,
        deterministic,
        verificationRound,
        { round: verificationRound, instructions: "Retry verification only against the unchanged retained candidate. Use the leanest valid evidence path and do not implement or edit files.", history: [] },
      );
      const records = [...deterministic, ...planned];
      if (!requiredVerificationPassed(records)) {
        const reason = recoveryEvidence(records);
        await this.recordRetainedVerificationFailure(input, sink, candidate, reason);
        return { kind: "verification-failed", reason, candidateRetained: true };
      }
      const published = await this.integrator.publish(candidate, input.workspacePath);
      const refreshed = await buildApplicationMap(
        input.workspacePath,
        input.orchestration.id,
        input.plan.applicationMap.version + 1,
        this.now(),
      );
      this.maps.set(input.orchestration.id, refreshed);
      await sink.recordApplicationMap(refreshed.summary);
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: "verified-publish",
        actorRole: "control-plane",
        modelId: null,
        summary: "Verification-only recovery passed and published the retained candidate",
        metadata: { fileCount: published.length, applicationMapVersion: refreshed.summary.version },
      });
      await this.integrator.cleanup(candidate);
      await this.workspaces.cleanupOrchestration(input.orchestration.id, "clean");
      return { kind: "completed", finalOutput: `Verification recovery passed and published ${published.length} retained candidate files.` };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled", reason: "Verification retry cancelled" };
      const reason = error instanceof Error ? error.message : String(error);
      const infrastructureFailure = isVerificationInfrastructureFailure(error);
      const retainedReason = infrastructureFailure
        ? `Verification inconclusive: ${reason}`
        : reason;
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: infrastructureFailure
          ? "verification-only-retry-inconclusive"
          : "verification-only-retry-failed",
        actorRole: "control-plane",
        modelId: null,
        summary: infrastructureFailure
          ? "Verification-only retry was inconclusive; the unchanged candidate remains retained"
          : "Verification-only retry failed; the unchanged candidate remains retained",
        metadata: {
          verificationRound,
          error: reason.slice(0, 2_000),
          candidateRetained: true,
        },
      });
      return { kind: "verification-failed", reason: retainedReason, candidateRetained: true };
    } finally {
      this.activeRoles.delete(input.orchestration.id);
    }
  }

  private roles(orchestrationId: string, sink: OrchestrationSink): RoleExecutor {
    const existing = this.activeRoles.get(orchestrationId);
    if (existing) return existing;
    const roles = new RoleExecutor(
      this.options.runner,
      sink,
      this.options.models,
      this.options.runtimeHomeRoot,
      this.newId,
      this.options.modelCallTimeoutMs,
      this.options.modelTransportMaxRetries,
    );
    this.activeRoles.set(orchestrationId, roles);
    return roles;
  }

  private async integrateAndVerify(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    results: WorkerLoopResult[],
    signal: AbortSignal,
  ): Promise<IntegrationGateResult> {
    const maximumRecoveryRounds = Math.max(1, input.orchestration.budget.maxWorkerAttempts);
    const recoveryHistory: string[] = [];
    let recoveryRound = 0;
    let candidate: IntegrationCandidate | null = null;
    let integratorGuidance = "";
    let verifierGuidance = "";

    while (true) {
      if (signal.aborted) {
        if (candidate) await this.integrator.cleanup(candidate).catch(() => undefined);
        return { kind: "outcome", outcome: { kind: "cancelled", reason: "Orchestration cancelled" } };
      }
      if (!candidate) {
        try {
          candidate = await this.createIntegrationCandidate(
            input,
            sink,
            roles,
            results,
            signal,
            recoveryRound,
            integratorGuidance,
          );
        } catch (integrationError) {
          await this.integrator.discard(input.orchestration.id).catch(() => undefined);
          const evidence = integrationError instanceof Error
            ? integrationError.message
            : String(integrationError);
          const decision = await this.requestRecoveryDecision(
            input,
            sink,
            roles,
            "integration",
            evidence,
            recoveryHistory,
            input.workspacePath,
            recoveryRound,
            signal,
          );
          const outcome = this.recoveryOutcome(
            input,
            decision,
            evidence,
            recoveryRound >= maximumRecoveryRounds,
          );
          if (outcome) return { kind: "outcome", outcome };
          try {
            if (decision.action === "retry-direct") {
              await this.runDirectRecovery(
                input,
                sink,
                roles,
                results,
                decision,
                evidence,
                recoveryRound + 1,
                signal,
              );
            } else if (decision.action === "retry-worker") {
              await this.runRecoveryWorkers(input, sink, roles, results, decision, evidence, recoveryRound + 1, signal);
            }
            integratorGuidance = decision.instructions || decision.reason;
            recoveryHistory.push(
              `Round ${recoveryRound + 1}: supervisor selected ${decision.action} after integration failure: ${decision.reason}`,
            );
          } catch (recoveryError) {
            const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            recoveryHistory.push(`Round ${recoveryRound + 1}: ${decision.action} failed: ${reason}`);
            await this.recordRecoveryActionFailure(input, sink, decision, recoveryRound + 1, reason);
          }
          recoveryRound += 1;
          continue;
        }
      }

      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: "verification-step",
        actorRole: "control-plane",
        modelId: null,
        summary: recoveryRound
          ? `Started protected and global verification recovery round ${recoveryRound}`
          : "Started protected and global verification",
        metadata: { recoveryRound },
      });
      let records: VerificationRecord[];
      try {
        const verification = await this.verification.run(
          input.orchestration.id,
          null,
          candidate.path,
          ["protected", "global", "manual"],
          sink,
          signal,
          `release-${recoveryRound}`,
        );
        const plannedVerification = await this.runPlannedAcceptanceVerification(
          input,
          roles,
          candidate.path,
          sink,
          signal,
          verification,
          recoveryRound,
          verifierGuidance
            ? { round: recoveryRound, instructions: verifierGuidance, history: recoveryHistory }
            : undefined,
        );
        records = [...verification, ...plannedVerification];
      } catch (verificationError) {
        if (signal.aborted) throw verificationError;
        const now = this.now().toISOString();
        const reason = verificationError instanceof Error
          ? verificationError.message
          : String(verificationError);
        const infrastructureFailure = isVerificationInfrastructureFailure(verificationError);
        const failureRecord: VerificationRecord = {
          id: `verification-execution-${input.contract.id}-${recoveryRound}`,
          orchestrationId: input.orchestration.id,
          taskId: null,
          scope: "protected",
          commandOrCheck: "Verification phase execution",
          status: "failed",
          outputSummary: infrastructureFailure
            ? `Verification inconclusive because the verifier runtime or model connection failed: ${reason}`.slice(0, 8_000)
            : `Verifier execution error: ${reason}`.slice(0, 8_000),
          startedAt: now,
          completedAt: now,
        };
        await sink.recordVerification(failureRecord);
        await sink.recordEvent({
          orchestrationId: input.orchestration.id,
          taskId: null,
          executionId: null,
          type: infrastructureFailure
            ? "verification-inconclusive"
            : "verification-execution-failed",
          actorRole: "control-plane",
          modelId: null,
          summary: infrastructureFailure
            ? "Verification was inconclusive; the unchanged candidate is available for verification-only retry"
            : "Verifier execution failed and was routed through bounded recovery",
          metadata: {
            recoveryRound,
            error: reason.slice(0, 2_000),
            candidateRetained: infrastructureFailure,
          },
        });
        if (infrastructureFailure) {
          const inconclusiveReason = `Verification inconclusive: ${reason}`;
          await this.recordRetainedVerificationFailure(
            input,
            sink,
            candidate,
            inconclusiveReason,
          );
          return {
            kind: "outcome",
            outcome: {
              kind: "verification-failed",
              reason: inconclusiveReason,
              candidateRetained: true,
            },
          };
        }
        records = [failureRecord];
      }
      if (requiredVerificationPassed(records)) return { kind: "verified", candidate };

      const evidence = recoveryEvidence(records);
      let decision: RecoveryDecision;
      try {
        decision = await this.requestRecoveryDecision(
          input,
          sink,
          roles,
          "verification",
          evidence,
          recoveryHistory,
          candidate.path,
          recoveryRound,
          signal,
        );
      } catch (supervisorError) {
        const reason = supervisorError instanceof Error ? supervisorError.message : String(supervisorError);
        await this.recordRetainedVerificationFailure(input, sink, candidate, reason);
        return { kind: "outcome", outcome: { kind: "verification-failed", reason, candidateRetained: true } };
      }
      const outcome = this.recoveryOutcome(
        input,
        decision,
        evidence,
        recoveryRound >= maximumRecoveryRounds,
      );
      if (outcome) {
        if (outcome.kind === "failed") {
          await this.recordRetainedVerificationFailure(input, sink, candidate, outcome.reason);
          return { kind: "outcome", outcome: { kind: "verification-failed", reason: outcome.reason, candidateRetained: true } };
        }
        await this.integrator.cleanup(candidate).catch(() => undefined);
        return { kind: "outcome", outcome };
      }

      try {
        if (decision.action === "retry-direct") {
          await this.integrator.cleanup(candidate);
          candidate = null;
          await this.runDirectRecovery(
            input,
            sink,
            roles,
            results,
            decision,
            evidence,
            recoveryRound + 1,
            signal,
          );
          integratorGuidance = "";
          verifierGuidance = "";
        } else if (decision.action === "retry-worker") {
          await this.integrator.cleanup(candidate);
          candidate = null;
          await this.runRecoveryWorkers(
            input,
            sink,
            roles,
            results,
            decision,
            evidence,
            recoveryRound + 1,
            signal,
          );
          integratorGuidance = "";
          verifierGuidance = "";
        } else if (decision.action === "retry-integrator") {
          candidate = await this.runIntegratorRecovery(
            input,
            sink,
            roles,
            candidate,
            results,
            decision,
            evidence,
            recoveryRound + 1,
            signal,
          );
          verifierGuidance = "";
        } else {
          verifierGuidance = decision.instructions || decision.reason;
        }
        recoveryHistory.push(
          `Round ${recoveryRound + 1}: supervisor selected ${decision.action}: ${decision.reason}`,
        );
      } catch (recoveryError) {
        const reason = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        recoveryHistory.push(`Round ${recoveryRound + 1}: ${decision.action} failed: ${reason}`);
        await this.recordRecoveryActionFailure(input, sink, decision, recoveryRound + 1, reason);
        if (!candidate) {
          for (const result of results) result.changes = await this.workspaces.changes(result.workspace);
        } else if (decision.action === "retry-integrator") {
          candidate = await this.integrator.refresh(candidate).catch(() => candidate);
        }
      }
      recoveryRound += 1;
    }
  }

  private async recordRetainedVerificationFailure(
    input: ExecuteInput,
    sink: OrchestrationSink,
    candidate: IntegrationCandidate,
    reason: string,
  ): Promise<void> {
    const inconclusive = /verification inconclusive|runtime timed out|stream disconnected|error sending request/i.test(reason);
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "verification-candidate-retained",
      actorRole: "control-plane",
      modelId: null,
      summary: inconclusive
        ? "Verification was inconclusive; the integrated candidate was retained for a verification-only retry"
        : "Verification failed; the integrated candidate was retained for a verification-only retry",
      metadata: {
        changedFiles: candidate.changes.changedFiles.length,
        deletedFiles: candidate.changes.deletedFiles.length,
        reason: reason.slice(0, 1_500),
        inconclusive,
      },
    });
  }

  private async createIntegrationCandidate(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    results: WorkerLoopResult[],
    signal: AbortSignal,
    recoveryRound: number,
    supervisorInstructions: string,
  ): Promise<IntegrationCandidate> {
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "integration-step",
      actorRole: "control-plane",
      modelId: null,
      summary: recoveryRound
        ? `Restarted deterministic-first integration for recovery round ${recoveryRound}`
        : "Started deterministic-first integration",
      metadata: { workerResultCount: results.length, recoveryRound },
    });
    const candidate = await this.integrator.integrate(
      input.orchestration.id,
      input.workspacePath,
      results.map((result) => ({
        taskId: result.task.id,
        workspacePath: result.workspace.path,
        changes: result.changes,
      })),
      async (conflict) => {
        const resolved = await roles.structured(
          {
            orchestrationId: input.orchestration.id,
            agentId: input.orchestration.agentId,
            taskId: null,
            role: "integrator",
            workspacePath: input.workspacePath,
            sandboxMode: "read-only",
            signal,
            prompt: [
              `Resolve only conflict ${conflict.path} against contract v${input.contract.version}.`,
              ...(supervisorInstructions
                ? [`Big-model supervisor guidance: ${supervisorInstructions}`]
                : []),
              ...conflict.variants.map((variant) => `Task ${variant.taskId}:\n${variant.content.toString("utf8").slice(0, 12_000)}`),
              "Return JSON with content only.",
            ].join("\n"),
            maxArkApiTurns: Math.min(8, input.orchestration.budget.maxArkApiTurnsPerExecution ?? 8),
            maxInputTokens: Math.min(120_000, input.orchestration.budget.maxInputTokensPerExecution ?? 120_000),
          },
          conflictSchema,
        );
        return Buffer.from(resolved.value.content);
      },
    );
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "integration-candidate",
      actorRole: "control-plane",
      modelId: null,
      summary: "Deterministic-first integration candidate created",
      metadata: {
        changedFiles: candidate.changes.changedFiles.length,
        conflicts: candidate.conflicts.length,
        recoveryRound,
      },
    });
    return candidate;
  }

  private async requestRecoveryDecision(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    phase: "integration" | "verification",
    failureEvidence: string,
    recoveryHistory: string[],
    workspacePath: string,
    recoveryRound: number,
    signal: AbortSignal,
  ): Promise<RecoveryDecision> {
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "supervisor-recovery-escalation",
      actorRole: "control-plane",
      modelId: null,
      summary: `Escalated ${phase} failure to the big-model supervisor`,
      metadata: { phase, recoveryRound },
    });
    const call = await roles.structured(
      {
        orchestrationId: input.orchestration.id,
        agentId: input.orchestration.agentId,
        taskId: null,
        role: "planner",
        workspacePath,
        sandboxMode: "read-only",
        signal,
        prompt: [
          "Act as the big-model supervisor for the configured execution roles.",
          "This is an evidence-only control decision. Do not call tools, inspect the workspace, run commands, or attempt implementation. Use only the supplied contract, task summaries, failure evidence, and recovery history, then immediately return the required JSON decision.",
          `The ${phase} phase failed. Diagnose the evidence and choose the next action that is most likely to produce a verified result.`,
          input.plan.selectedMode === "direct"
            ? "This is Direct mode. There are no small workers or small integrator. Use retry-direct for implementation or candidate corrections so the same big Direct executor performs the fix. Never choose retry-worker or retry-integrator."
            : "This is an orchestrated worker mode. Use retry-worker for implementation defects, retry-integrator for merge/composition defects, and retry-verifier when a different valid verification method can establish evidence. Do not choose retry-direct.",
          "Use retry-verifier when a different valid verification method can establish evidence without weakening the confirmed criteria.",
          "Choose needs-user only when a permission, credential, material choice, or external action is genuinely required from the user. Include one precise userQuestion in that case.",
          "Choose stop only for a demonstrated non-recoverable contradiction. Never waive a confirmed acceptance criterion, fabricate evidence, or mark an uncertain check as passed.",
          "For any retry, provide concrete instructions for the selected smaller model. For retry-worker, include the exact target task IDs.",
          `Confirmed contract: ${JSON.stringify({ version: input.contract.version, goal: input.contract.intent.goal, criteria: input.contract.criteria.map(({ id, kind, description }) => ({ id, kind, description: description.slice(0, 800) })) })}`,
          `Available tasks: ${JSON.stringify(resultsForSupervisor(input.plan.tasks))}`,
          `Failure evidence: ${failureEvidence.slice(0, 24_000)}`,
          `Prior recovery history: ${JSON.stringify(recoveryHistory.slice(-4))}`,
          `Recovery round: ${recoveryRound}`,
        ].join("\n").slice(0, 48_000),
        maxArkApiTurns: Math.min(2, input.orchestration.budget.maxArkApiTurnsPerExecution ?? 2),
        maxInputTokens: Math.min(60_000, input.orchestration.budget.maxInputTokensPerExecution ?? 60_000),
        maxToolCalls: 1,
        timeoutMs: 60_000,
      },
      recoveryDecisionSchema,
    );
    const requestedAction = call.value.action;
    const modelDecision: RecoveryDecision = input.plan.selectedMode === "direct"
      ? requestedAction === "retry-worker" || requestedAction === "retry-integrator"
        ? { ...call.value, action: "retry-direct" }
        : call.value
      : requestedAction === "retry-direct"
        ? { ...call.value, action: "retry-worker" }
        : call.value;
    const decision: RecoveryDecision = isInternalInfrastructureFailure(failureEvidence) &&
      (modelDecision.action === "needs-user" || modelDecision.action === "stop")
      ? {
          ...modelDecision,
          classification: "transient-failure",
          action: phase === "verification"
            ? "retry-verifier"
            : input.plan.selectedMode === "direct"
              ? "retry-direct"
              : "retry-integrator",
          reason: "The Runtime launcher failed internally and should be retried without involving the user.",
          instructions: "Retry from the last checkpoint using compact evidence. Do not serialize generated cache paths into the prompt.",
          targetTaskIds: [],
          userQuestion: null,
        }
      : modelDecision;
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: call.executionId,
      type: "supervisor-recovery-decision",
      actorRole: "planner",
      modelId: call.actualModelId,
      summary: decision.reason,
      metadata: {
        phase,
        recoveryRound,
        classification: decision.classification,
        action: decision.action,
        requestedAction,
        targetTaskCount: decision.targetTaskIds.length,
      },
    });
    return decision;
  }

  private recoveryOutcome(
    input: ExecuteInput,
    decision: RecoveryDecision,
    failureEvidence: string,
    exhausted: boolean,
  ): IncompleteExecutionOutcome | null {
    const userActionable =
      decision.classification === "permission-required" ||
      looksUserActionableFailure(`${decision.reason}\n${failureEvidence}`);
    if (exhausted && isInternalInfrastructureFailure(failureEvidence)) {
      return {
        kind: "failed",
        reason: `Automatic recovery from an internal Runtime launch failure was exhausted: ${decision.reason}`,
      };
    }
    if (decision.action === "needs-user" || (decision.action === "stop" && userActionable)) {
      const question = decision.userQuestion ??
        "What permission, credential, or external action should be used to unblock verification?";
      return {
        kind: "needs-user",
        amendment: this.amendment(input, decision.reason, question),
      };
    }
    if (decision.action === "stop") return { kind: "failed", reason: decision.reason };
    if (!exhausted) return null;
    if (userActionable || decision.classification === "environment-capability") {
      return {
        kind: "needs-user",
        amendment: this.amendment(
          input,
          `Automatic recovery was exhausted. ${decision.reason}`,
          decision.userQuestion ??
            "Automatic recovery could not overcome the environment limitation. What permission or alternative execution approach should be used?",
        ),
      };
    }
    return {
      kind: "failed",
      reason: `Automatic recovery was exhausted: ${decision.reason}`,
    };
  }

  private async runDirectRecovery(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    results: WorkerLoopResult[],
    decision: RecoveryDecision,
    failureEvidence: string,
    recoveryRound: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (input.plan.selectedMode !== "direct") {
      throw new Error("Direct recovery is only valid for a Direct execution plan");
    }
    const result = results[0];
    if (!result) throw new Error("Direct recovery requires the original Direct execution workspace");
    result.task.status = "running";
    result.task.attemptCount += 1;
    await sink.upsertTask(result.task);
    const call = await roles.text({
      orchestrationId: input.orchestration.id,
      agentId: input.orchestration.agentId,
      taskId: result.task.id,
      role: "planner",
      workspacePath: result.workspace.path,
      sandboxMode: "workspace-write",
      signal,
      prompt: [
        "Resume the confirmed Direct execution as the same big-model executor.",
        "Integrated verification failed. Diagnose the evidence, implement the fix yourself in the existing Direct workspace, and run relevant checks.",
        "Do not delegate to smaller workers or an integration model, and do not merely explain the failure.",
        `Allowed edit paths: ${JSON.stringify(result.task.allowedPaths)}`,
        `Confirmed contract: ${JSON.stringify({ goal: input.contract.intent.goal, criteria: input.contract.criteria })}`,
        `Failed verification evidence: ${failureEvidence.slice(0, 24_000)}`,
        `Supervisor instructions: ${decision.instructions || decision.reason}`,
      ].join("\n").slice(0, 48_000),
      maxArkApiTurns: input.orchestration.budget.maxArkApiTurnsPerExecution,
      maxInputTokens: input.orchestration.budget.maxInputTokensPerExecution,
    });
    const changes = await this.workspaces.changes(result.workspace);
    const violations = scopeViolations(changes, result.task.allowedPaths);
    if (violations.length) throw new Error(`Direct recovery scope violation: ${scopeViolationSummary(violations)}`);
    const visible = await this.verification.run(
      input.orchestration.id,
      result.task.id,
      result.workspace.path,
      ["worker-visible"],
      sink,
      signal,
    );
    if (!requiredVerificationPassed(visible)) {
      throw new Error("Direct recovery visible verification failed");
    }
    result.changes = changes;
    result.summary = call.rawOutput.slice(0, 8_000);
    result.usage = addUsage(result.usage, call.usage);
    result.task.status = "passed";
    await sink.upsertTask(result.task);
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: result.task.id,
      executionId: call.executionId,
      type: "recovery-direct-completed",
      actorRole: "planner",
      modelId: call.actualModelId,
      summary: "Big Direct executor completed supervisor-directed recovery work",
      metadata: {
        recoveryRound,
        changedFiles: changes.changedFiles.length,
        deletedFiles: changes.deletedFiles.length,
      },
    });
  }

  private async runRecoveryWorkers(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    results: WorkerLoopResult[],
    decision: RecoveryDecision,
    failureEvidence: string,
    recoveryRound: number,
    signal: AbortSignal,
  ): Promise<void> {
    const requested = new Set(decision.targetTaskIds);
    const selected = results.filter((result) => requested.has(result.task.id));
    const targets = selected.length ? selected : results;
    await Promise.all(targets.map(async (result) => {
      result.task.status = "running";
      result.task.attemptCount += 1;
      await sink.upsertTask(result.task);
      const call = await roles.text({
        orchestrationId: input.orchestration.id,
        agentId: input.orchestration.agentId,
        taskId: result.task.id,
        role: "worker",
        workspacePath: result.workspace.path,
        sandboxMode: "workspace-write",
        signal,
        prompt: [
          "A big-model supervisor is asking you to repair a failed integrated verification.",
          "Inspect the current task workspace and implement the supervisor instructions. Do not merely explain the issue.",
          `Task: ${JSON.stringify({ id: result.task.id, objective: result.task.objective, allowedPaths: result.task.allowedPaths })}`,
          `Confirmed criteria: ${JSON.stringify(input.contract.criteria.filter((criterion) => result.task.acceptanceCriterionIds.includes(criterion.id)))}`,
          `Failed verification evidence: ${failureEvidence.slice(0, 24_000)}`,
          `Supervisor instructions: ${decision.instructions || decision.reason}`,
          "Edit only the allowed paths, run relevant checks, and summarize what you changed.",
        ].join("\n").slice(0, 48_000),
        maxArkApiTurns: input.orchestration.budget.maxArkApiTurnsPerExecution,
        maxInputTokens: input.orchestration.budget.maxInputTokensPerExecution,
      });
      const changes = await this.workspaces.changes(result.workspace);
      const violations = scopeViolations(changes, result.task.allowedPaths);
      if (violations.length) throw new Error(`Recovery worker scope violation: ${scopeViolationSummary(violations)}`);
      const visible = await this.verification.run(
        input.orchestration.id,
        result.task.id,
        result.workspace.path,
        ["worker-visible"],
        sink,
        signal,
      );
      if (!requiredVerificationPassed(visible)) {
        throw new Error(`Recovery worker-visible verification failed for task ${result.task.id}`);
      }
      result.changes = changes;
      result.summary = call.rawOutput.slice(0, 8_000);
      result.usage = addUsage(result.usage, call.usage);
      result.task.status = "passed";
      await sink.upsertTask(result.task);
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: result.task.id,
        executionId: call.executionId,
        type: "recovery-worker-completed",
        actorRole: "worker",
        modelId: call.actualModelId,
        summary: "Small worker completed big-model-directed recovery work",
        metadata: {
          recoveryRound,
          changedFiles: changes.changedFiles.length,
          deletedFiles: changes.deletedFiles.length,
        },
      });
    }));
  }

  private async runIntegratorRecovery(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    candidate: IntegrationCandidate,
    results: WorkerLoopResult[],
    decision: RecoveryDecision,
    failureEvidence: string,
    recoveryRound: number,
    signal: AbortSignal,
  ): Promise<IntegrationCandidate> {
    const allowedPaths = [...new Set(results.flatMap((result) => result.task.allowedPaths))];
    const call = await roles.text({
      orchestrationId: input.orchestration.id,
      agentId: input.orchestration.agentId,
      taskId: null,
      role: "integrator",
      workspacePath: candidate.path,
      sandboxMode: "workspace-write",
      signal,
      prompt: [
        "Apply the supervisor's integration recovery instructions to the integrated candidate.",
        "Inspect the candidate and make only integration/composition corrections. Do not weaken tests or confirmed criteria.",
        `Allowed edit paths across confirmed tasks: ${JSON.stringify(allowedPaths)}`,
        `Confirmed contract: ${JSON.stringify({ goal: input.contract.intent.goal, criteria: input.contract.criteria })}`,
        `Failed verification evidence: ${failureEvidence.slice(0, 24_000)}`,
        `Supervisor instructions: ${decision.instructions || decision.reason}`,
        "Edit the candidate directly, run relevant non-destructive checks, and summarize the correction.",
      ].join("\n").slice(0, 48_000),
      maxArkApiTurns: input.orchestration.budget.maxArkApiTurnsPerExecution,
      maxInputTokens: input.orchestration.budget.maxInputTokensPerExecution,
    });
    const refreshed = await this.integrator.refresh(candidate);
    const violations = scopeViolations(refreshed.changes, allowedPaths);
    if (violations.length) throw new Error(`Recovery integrator scope violation: ${scopeViolationSummary(violations)}`);
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: call.executionId,
      type: "recovery-integrator-completed",
      actorRole: "integrator",
      modelId: call.actualModelId,
      summary: "Small integrator completed big-model-directed recovery work",
      metadata: { recoveryRound, changedFiles: refreshed.changes.changedFiles.length },
    });
    return refreshed;
  }

  private async recordRecoveryActionFailure(
    input: ExecuteInput,
    sink: OrchestrationSink,
    decision: RecoveryDecision,
    recoveryRound: number,
    reason: string,
  ): Promise<void> {
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "recovery-action-failed",
      actorRole: "control-plane",
      modelId: null,
      summary: reason.slice(0, 2_000),
      metadata: { recoveryRound, action: decision.action },
    });
  }

  private async runDirect(
    input: ExecuteInput,
    sink: OrchestrationSink,
    roles: RoleExecutor,
    signal: AbortSignal,
  ): Promise<WorkerLoopResult> {
    const task = input.plan.tasks[0]!;
    const workspace = await this.workspaces.create(
      input.workspacePath,
      input.orchestration.id,
      task.id,
      task.allowedPaths,
    );
    task.status = "running";
    await sink.upsertTask(task);
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: task.id,
      executionId: null,
      type: "direct-step",
      actorRole: "control-plane",
      modelId: null,
      summary: "Started bounded direct execution",
      metadata: { selectedMode: "direct" },
    });
    const call = await roles.text({
      orchestrationId: input.orchestration.id,
      agentId: input.orchestration.agentId,
      taskId: task.id,
      role: "planner",
      workspacePath: workspace.path,
      sandboxMode: "workspace-write",
      signal,
      prompt: [
        "Execute the confirmed direct task in the workspace as the single big-model implementer.",
        `Task: ${task.objective}`,
        `Edit only: ${JSON.stringify(task.allowedPaths)}`,
        `Confirmed goal: ${input.contract.intent.goal}`,
        `Relevant criteria: ${JSON.stringify(input.contract.criteria.filter((criterion) => task.acceptanceCriterionIds.includes(criterion.id)).map(({ id, kind, description }) => ({ id, kind, description: description.slice(0, 800) })))}`,
        "Batch related inspection and checks. Keep tool output compact and leave completed edits in the workspace as checkpoints.",
      ].join("\n").slice(0, 48_000),
      maxArkApiTurns: input.orchestration.budget.maxArkApiTurnsPerExecution,
      maxInputTokens: input.orchestration.budget.maxInputTokensPerExecution,
    });
    const changes = await this.workspaces.changes(workspace);
    const violations = scopeViolations(changes, task.allowedPaths);
    if (violations.length) throw new Error(`Direct execution scope violation: ${scopeViolationSummary(violations)}`);
    if (!changes.changedFiles.length && !changes.deletedFiles.length) {
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: task.id,
        executionId: call.executionId,
        type: "direct-no-workspace-change",
        actorRole: "control-plane",
        modelId: call.actualModelId,
        summary: "Direct execution completed without workspace changes",
        metadata: {},
      });
    }
    const visible = await this.verification.run(
      input.orchestration.id,
      task.id,
      workspace.path,
      ["worker-visible"],
      sink,
      signal,
    );
    if (!requiredVerificationPassed(visible)) throw new Error("Direct visible verification failed");
    task.status = "passed";
    await sink.upsertTask(task);
    return { task, workspace, changes, summary: call.rawOutput.slice(0, 8_000), usage: call.usage, staleTaskIds: [] };
  }

  private amendment(input: ExecuteInput, reason: string, userQuestion?: string): ContractAmendment {
    const now = this.now().toISOString();
    return {
      id: this.newId(),
      orchestrationId: input.orchestration.id,
      baseContractId: input.contract.id,
      proposedIntent: {
        ...structuredClone(input.contract.intent),
        id: this.newId(),
        revision: input.contract.intent.revision + 1,
        materialQuestions: userQuestion ? [userQuestion] : [],
        createdAt: now,
      },
      proposedCriteria: null,
      reason,
      material: true,
      status: "pending",
      createdAt: now,
      decidedAt: null,
    };
  }

  private async runPlannedAcceptanceVerification(
    input: ExecuteInput,
    roles: RoleExecutor,
    candidateWorkspacePath: string,
    sink: OrchestrationSink,
    signal: AbortSignal,
    deterministicRecords: VerificationRecord[],
    verificationRound: number,
    recovery?: { round: number; instructions: string; history: string[] },
  ) {
    const plan = await this.verification.loadAcceptancePlan(
      input.orchestration.id,
      input.contract.version,
    );
    const startingMap = this.maps.get(input.orchestration.id);
    const skipBaselineRegression = Boolean(
      startingMap && !hasExistingRegressionInfrastructure(startingMap),
    );
    const skippedRegressionIds = new Set(
      skipBaselineRegression
        ? plan.tests.filter((test) => test.category === "regression").map((test) => test.id)
        : [],
    );
    const postReleaseIds = new Set(
      plan.tests.filter(requiresPostReleaseVerification).map((test) => test.id),
    );
    const automated = plan.tests.filter(
      (test) =>
        test.scope !== "manual" &&
        !skippedRegressionIds.has(test.id) &&
        !postReleaseIds.has(test.id),
    );
    const candidateMap = await buildApplicationMap(
      candidateWorkspacePath,
      input.orchestration.id,
      input.plan.applicationMap.version + 1,
      this.now(),
    );
    const hasBuildOrRuntimeManifest = candidateMap.entries.some((entry) =>
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Dockerfile|compose\.ya?ml)$/i.test(entry.path)
    );
    const verificationProfile = selectAdaptiveVerificationProfile({
      fileCount: candidateMap.entries.length,
      totalBytes: candidateMap.entries.reduce((total, entry) => total + entry.bytes, 0),
      taskCount: input.plan.tasks.length,
      automatedTestCount: automated.length,
      hasBuildOrRuntimeManifest,
      recoveryRound: verificationRound,
    });
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "verification-profile-selected",
      actorRole: "control-plane",
      modelId: null,
      summary: `Selected the ${verificationProfile.name} adaptive verification profile`,
      metadata: {
        profile: verificationProfile.name,
        fileCount: candidateMap.entries.length,
        taskCount: input.plan.tasks.length,
        automatedTestCount: automated.length,
        hasBuildOrRuntimeManifest,
        maxArkApiTurns: verificationProfile.maxArkApiTurns,
        maxInputTokens: verificationProfile.maxInputTokens,
        maxToolCalls: verificationProfile.maxToolCalls,
        timeoutMs: verificationProfile.timeoutMs,
        maximumTransportAttempts: MAXIMUM_VERIFIER_TRANSPORT_RETRIES + 1,
      },
    });
    const sourcePreviewExtensions = new Set([
      ".html", ".css", ".scss", ".js", ".jsx", ".mjs", ".cjs",
      ".ts", ".tsx", ".json", ".md", ".txt", ".svg",
    ]);
    let remainingSourceCharacters = verificationProfile.name === "fast" ? 24_000 : 0;
    const sourcePreviews: Array<{ path: string; content: string }> = [];
    if (remainingSourceCharacters > 0) {
      for (const entry of candidateMap.entries) {
        if (remainingSourceCharacters <= 0 || sourcePreviews.length >= 20) break;
        if (!sourcePreviewExtensions.has(path.extname(entry.path).toLowerCase())) continue;
        const maximum = Math.min(12_000, remainingSourceCharacters);
        const content = await readFile(path.join(candidateWorkspacePath, entry.path), "utf8")
          .then((value) => value.slice(0, maximum))
          .catch(() => "");
        if (!content) continue;
        sourcePreviews.push({ path: entry.path, content });
        remainingSourceCharacters -= content.length;
      }
    }
    const evidenceBundle = {
      workspace: candidateMap.summary,
      files: candidateMap.entries.slice(0, verificationProfile.fileEvidenceLimit).map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
        imports: entry.imports.slice(0, 20),
        exports: entry.exports.slice(0, 20),
        summary: entry.summary.slice(0, verificationProfile.fileSummaryCharacters),
      })),
      changedAreas: input.plan.tasks.map((task) => ({
        task: task.title,
        allowedPaths: task.allowedPaths,
        criteria: task.acceptanceCriterionIds,
      })),
      deterministicChecks: deterministicRecords.map((record) => ({
        check: record.commandOrCheck,
        status: record.status,
        evidence: record.outputSummary.slice(0, 1_500),
      })),
      ...(sourcePreviews.length ? { sourcePreviews } : {}),
    };
    const compactAutomated = automated.map((test) => ({
      ...test,
      procedure: test.procedure.slice(0, verificationProfile.procedureCharacters),
      expectedOutcome: test.expectedOutcome.slice(0, verificationProfile.expectedOutcomeCharacters),
    }));
    const evidenceArtifactId = `verification-evidence-${input.contract.id}`;
    const artifactVersion = verificationRound + 1;
    await sink.publishArtifact({
      id: evidenceArtifactId,
      orchestrationId: input.orchestration.id,
      producerTaskId: "verifier",
      kind: "test-result",
      name: "Deterministic verification evidence",
      version: artifactVersion,
      payload: boundedJson(evidenceBundle, 40_000),
      createdAt: this.now().toISOString(),
    });
    const startedAt = this.now().toISOString();
    const result = automated.length
      ? await roles.structured(
          {
            orchestrationId: input.orchestration.id,
            agentId: input.orchestration.agentId,
            taskId: null,
            role: "verifier",
            workspacePath: candidateWorkspacePath,
            sandboxMode: "read-only",
            runtimeProfile: "verification",
            signal,
            prompt: [
              "Independently verify the integrated candidate. Do not edit any files.",
              `Adaptive verification profile: ${verificationProfile.name}. Finish within ${verificationProfile.maxArkApiTurns} total model turns and ${verificationProfile.maxToolCalls} total tool calls, including any structured-output repair. Stop as soon as every supplied test has concrete evidence.`,
              ...(verificationProfile.name === "fast"
                ? [
                    "This is the deterministic-first fast path. All relevant small source files are already included in sourcePreviews. Do not call tools, open files, start a browser, or run shell commands. Evaluate the supplied evidence once and immediately return the required compact JSON results.",
                  ]
                : []),
              "Start from the deterministic evidence bundle. Do not rediscover listed files. Inspect additional file contents only for acceptance tests that the supplied evidence cannot decide.",
              "Use a single-pass verification strategy. Do not behave like an implementation worker and do not iteratively debug a custom test framework.",
              ...(verificationProfile.maxShellInvocations > 0
                ? [`Use at most ${verificationProfile.maxShellInvocations} shell invocation${verificationProfile.maxShellInvocations === 1 ? "" : "s"}. Combine all necessary checks in one command or composite /tmp harness. Never install packages, and do not rerun a successful check.`]
                : []),
              "Batch all related non-destructive tests, type checks, builds, static checks, and browser checks into that composite harness. Keep successful output summarized and include only relevant failure lines.",
              "The candidate workspace is intentionally read-only. Put temporary test scripts, browser profiles, screenshots, caches, and logs under /tmp only.",
              "This verification runtime supports subprocesses, ephemeral loopback servers, and bundled Chromium. Use $CHROME_BIN or /usr/bin/chromium with a fresh --user-data-dir under /tmp; never launch a host GUI browser or use a host browser profile.",
              "The disposable outer container is the security boundary. Chromium may use --no-sandbox inside it when required. Prefer 127.0.0.1 with an ephemeral unprivileged port and shut down every server you start.",
              "Return exactly one result for every supplied acceptance test. Passing requires concrete evidence; uncertainty or an unverified claim must fail. Baseline regression tests are supplied only when the starting workspace has relevant automated-check infrastructure.",
              ...(recovery
                ? [
                    `This is verification recovery round ${recovery.round}.`,
                    `Big-model supervisor instructions: ${recovery.instructions}`,
                    `Prior recovery history: ${JSON.stringify(recovery.history.slice(-4))}`,
                    "Use a different valid verification strategy where instructed, but do not waive criteria or fabricate evidence.",
                  ]
                : []),
              `Evidence artifact: ${evidenceArtifactId}. The compact contents required for this pass are included below; do not request successful logs that are already summarized there.`,
              `Confirmed contract: ${JSON.stringify({ version: input.contract.version, goal: input.contract.intent.goal, criteria: input.contract.criteria.map(({ id, kind, description }) => ({ id, kind, description: description.slice(0, 800) })) })}`,
              `Deterministic evidence bundle: ${JSON.stringify(evidenceBundle)}`,
              `Unresolved planner-generated acceptance tests: ${JSON.stringify(compactAutomated)}`,
            ].join("\n").slice(0, verificationProfile.promptCharacters),
            maxArkApiTurns: Math.min(
              verificationProfile.maxArkApiTurns,
              input.orchestration.budget.maxArkApiTurnsPerExecution ?? verificationProfile.maxArkApiTurns,
            ),
            maxInputTokens: Math.min(
              verificationProfile.maxInputTokens,
              input.orchestration.budget.maxInputTokensPerExecution ?? verificationProfile.maxInputTokens,
            ),
            maxToolCalls: verificationProfile.maxToolCalls,
            timeoutMs: verificationProfile.timeoutMs,
            maxTransportRetries: MAXIMUM_VERIFIER_TRANSPORT_RETRIES,
          },
          acceptanceVerificationSchema,
        )
      : null;
    const returned = new Map(result?.value.results.map((entry) => [entry.testId, entry]) ?? []);
    const records = [];
    for (const test of plan.tests) {
      const testResult = returned.get(test.id);
      const manual = test.scope === "manual";
      const skippedRegression = skippedRegressionIds.has(test.id);
      const postRelease = postReleaseIds.has(test.id);
      const record = {
        id: `acceptance-${input.contract.id}-${artifactVersion}-${test.id}`.slice(0, 500),
        orchestrationId: input.orchestration.id,
        taskId: null,
        scope: manual ? "manual" as const : test.scope,
        commandOrCheck: test.title,
        status: manual || skippedRegression || postRelease
          ? "skipped" as const
          : testResult?.status ?? "failed" as const,
        outputSummary: manual
          ? `Manual review required: ${test.expectedOutcome}`
          : postRelease
            ? "Deferred until after verified publication because this outcome cannot exist during release-gate verification."
            : skippedRegression
              ? "Skipped as not applicable: the starting workspace had no existing automated regression-check infrastructure."
              : testResult?.evidence ?? "Verifier omitted this required planner-generated acceptance test",
        startedAt,
        completedAt: this.now().toISOString(),
      };
      await sink.recordVerification(record);
      records.push(record);
    }
    const resultArtifactId = `verification-results-${input.contract.id}`;
    await sink.publishArtifact({
      id: resultArtifactId,
      orchestrationId: input.orchestration.id,
      producerTaskId: "verifier",
      kind: "test-result",
      name: "Acceptance verification results",
      version: artifactVersion,
      payload: boundedJson(records.map((record) => ({
        check: record.commandOrCheck,
        status: record.status,
        evidence: record.outputSummary.slice(0, 1_500),
      })), 40_000),
      createdAt: this.now().toISOString(),
    });
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: result?.executionId ?? null,
      type: "acceptance-verification-completed",
      actorRole: "verifier",
      modelId: result?.actualModelId ?? this.options.models.verifier,
      summary: "Big verifier evaluated the planner-generated acceptance tests",
      metadata: {
        testCount: records.length,
        passed: records.filter((record) => record.status === "passed").length,
        failed: records.filter((record) => record.status === "failed").length,
        skipped: records.filter((record) => record.status === "skipped").length,
        manual: records.filter((record) => record.scope === "manual").length,
        regressionNotApplicable: skippedRegressionIds.size,
        deferredPostRelease: postReleaseIds.size,
        recoveryRound: verificationRound,
        evidenceArtifactId,
        resultArtifactId,
      },
    });
    return records;
  }

  private async cleanup(
    results: WorkerLoopResult[],
    policy: "clean" | "archive" | "retain",
  ): Promise<void> {
    await Promise.all(results.map((result) => this.workspaces.cleanup(result.workspace, policy)));
  }
}
