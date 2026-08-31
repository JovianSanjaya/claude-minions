import { randomUUID } from "node:crypto";
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
  comprehensiveAcceptanceTests,
  requiresPostReleaseVerification,
} from "./acceptance-plan.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { classifyFailure } from "./failure-packet.js";
import {
  DeterministicIntegrator,
  type ExecutionStage,
  type IntegrationCandidate,
} from "./integrator.js";
import {
  isInternalInfrastructureFailure,
  looksUserActionableFailure,
  recoveryDecisionSchema,
  recoveryEvidence,
  type RecoveryDecision,
} from "./recovery.js";
import {
  RoleExecutor,
  type ModelTransportRetryPolicy,
  type RoleModelConfiguration,
} from "./role-executor.js";
import { maximumWriteSafeBatch, selectRoute } from "./router.js";
import { requiredVerificationPassed, type TrustedVerificationCheck, VerificationService } from "./verification.js";
import {
  BoundedWorkerLoop,
  type WorkerLoopResult,
  WorkerLoopError,
  workerContinuationSegmentLimit,
} from "./worker-loop.js";
import { scopeViolations, WorkerWorkspaceManager } from "./worker-workspaces.js";

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

const PLAN_VERIFICATION_RECOVERY_ARK_TURN_RESERVE = 4;

function deterministicPlanArkApiTurns(value: {
  estimatedArkApiTurns: number;
  tasks: Array<{ estimatedArkApiTurns?: number | undefined }>;
}): number {
  if (!value.tasks.every((task) => task.estimatedArkApiTurns !== undefined)) {
    return value.estimatedArkApiTurns;
  }
  return value.tasks.reduce(
    (total, task) => total + task.estimatedArkApiTurns!,
    PLAN_VERIFICATION_RECOVERY_ARK_TURN_RESERVE,
  );
}

function taskWaveWidths(tasks: Array<{ dependsOn: number[]; allowedPaths: string[] }>): number[] {
  const completed = new Set<number>();
  const remaining = new Set(tasks.map((_, index) => index));
  const widths: number[] = [];
  const dependentCounts = tasks.map(() => 0);
  tasks.forEach((task, descendant) => {
    const ancestors = [...task.dependsOn];
    const seen = new Set<number>();
    while (ancestors.length) {
      const ancestor = ancestors.pop()!;
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      dependentCounts[ancestor] = dependentCounts[ancestor]! + 1;
      ancestors.push(...tasks[ancestor]!.dependsOn);
    }
  });

  while (remaining.size) {
    const ready = [...remaining].filter((index) =>
      tasks[index]!.dependsOn.every((dependency) => completed.has(dependency))
    );
    if (!ready.length) return [];
    const safeBatch = maximumWriteSafeBatch(
      ready.map((index) => ({ index, allowedPaths: tasks[index]!.allowedPaths })),
      ({ index }) => 1 + dependentCounts[index]!,
    );
    widths.push(safeBatch.length);
    for (const { index } of safeBatch) {
      remaining.delete(index);
      completed.add(index);
    }
  }

  return widths;
}

function maximumTaskWaveWidth(tasks: Array<{ dependsOn: number[]; allowedPaths: string[] }>): number {
  return Math.max(0, ...taskWaveWidths(tasks));
}

function executionTaskWaves(tasks: OrchestrationTask[]): OrchestrationTask[][] {
  const completed = new Set<string>();
  const remaining = new Set(tasks.map((task) => task.id));
  const waves: OrchestrationTask[][] = [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependentCounts = new Map(tasks.map((task) => [task.id, 0]));
  for (const task of tasks) {
    const ancestors = [...task.dependsOn];
    const seen = new Set<string>();
    while (ancestors.length) {
      const ancestor = ancestors.pop()!;
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      dependentCounts.set(ancestor, (dependentCounts.get(ancestor) ?? 0) + 1);
      ancestors.push(...(tasksById.get(ancestor)?.dependsOn ?? []));
    }
  }
  while (remaining.size) {
    const ready = tasks.filter(
      (task) => remaining.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (!ready.length) throw new Error("Plan dependency graph cannot make progress");
    const wave = maximumWriteSafeBatch(
      ready,
      (task) => 1 + (dependentCounts.get(task.id) ?? 0),
    );
    if (!wave.length) throw new Error("Write-safe scheduler cannot make progress");
    waves.push(wave);
    for (const task of wave) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
  }
  return waves;
}

const planSchema = (
  maximumEstimatedCalls: number,
  maximumEstimatedArkTurns: number,
  maximumTaskArkTurns: number,
  maximumTaskInputTokens: number,
) => z.object({
  coupling: z.preprocess((value) => typeof value === "string" ? value.toLowerCase() : value, z.enum(["low", "medium", "high"])),
  estimatedCalls: z.coerce.number().int().positive().max(maximumEstimatedCalls),
  estimatedArkApiTurns: z.coerce.number().int().positive()
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
}).strip().superRefine((value, context) => {
  const defaultTurns = Math.ceil(value.estimatedArkApiTurns / value.tasks.length);
  const contextPerTask = Math.max(1, Math.ceil(value.estimatedContextTokens / value.tasks.length));
  value.tasks.forEach((task, index) => {
    for (const dependency of task.dependsOn) {
      if (dependency >= index) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "dependsOn"],
          message: "Task dependencies must reference earlier tasks only",
        });
      }
    }
    const estimatedTurns = task.estimatedArkApiTurns ?? defaultTurns;
    const estimatedInput = task.estimatedInputTokens ?? contextPerTask * estimatedTurns;
    if (estimatedTurns > maximumTaskArkTurns) {
      context.addIssue({
        code: "custom",
        path: ["tasks", index, "estimatedArkApiTurns"],
        message: `Task requires about ${estimatedTurns} Ark turns but its ${maximumTaskArkTurns}-turn continuation capacity is smaller. Split it into bounded tasks with coherent objectives, add only genuine data dependencies, and allow the scheduler to serialize overlapping write scopes.`,
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
  const allTaskTurnsAreExplicit = value.tasks.every(
    (task) => task.estimatedArkApiTurns !== undefined,
  );
  const explicitTaskTurns = value.tasks.reduce(
    (total, task) => total + (task.estimatedArkApiTurns ?? 0),
    0,
  );
  const requiredArkApiTurns = allTaskTurnsAreExplicit
    ? explicitTaskTurns + PLAN_VERIFICATION_RECOVERY_ARK_TURN_RESERVE
    : value.estimatedArkApiTurns;
  if (requiredArkApiTurns > maximumEstimatedArkTurns) {
    context.addIssue({
      code: "custom",
      path: ["estimatedArkApiTurns"],
      message: allTaskTurnsAreExplicit
        ? `Task estimates total ${explicitTaskTurns} Ark turns; with the ${PLAN_VERIFICATION_RECOVERY_ARK_TURN_RESERVE}-turn verification/recovery reserve, ${requiredArkApiTurns} are required but only ${maximumEstimatedArkTurns} are available.`
        : `The plan estimates ${requiredArkApiTurns} Ark turns but only ${maximumEstimatedArkTurns} are available.`,
    });
  }
});

const MAXIMUM_PLANNER_RESPONSE_CALLS = 2;
const MAXIMUM_PLANNER_ARK_TURN_RESERVE = 4;

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
}).strict();

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
  modelTransportRetryPolicy?: Partial<ModelTransportRetryPolicy>;
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
    const planningMap = {
      summary: map.summary,
      packageBoundaries: map.packageBoundaries,
      topLevelAreas: [...new Set(map.entries.map((entry) => entry.path.split("/")[0]))].slice(0, 100),
      paths: map.entries.slice(0, 800).map((entry) => entry.path),
      details: map.entries
        .filter((entry) =>
          /(^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|readme\.md|[^/]+\.config\.[^/]+)$/i.test(entry.path) ||
          /(^|\/)(?:src|app|apps|server|client|web|api|public|tests?)\//i.test(entry.path)
        )
        .slice(0, 240)
        .map((entry) => ({
          path: entry.path,
          imports: entry.imports.slice(0, 12),
          exports: entry.exports.slice(0, 12),
          summary: entry.summary,
        })),
      truncated: map.entries.length > 800,
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
        prompt: [
          "Create the most execution-efficient correct coding task graph for the confirmed contract. Do not edit files or call tools.",
          `Compact contract: ${JSON.stringify(compactContract)}`,
          `Compact application map: ${JSON.stringify(planningMap)}`,
          `Total model-call budget: ${input.orchestration.budget.maxModelCalls}`,
          `Model calls already consumed before this planning response: ${alreadyConsumedModelCalls}`,
          `Model calls reserved for this response and one possible format-repair response: ${MAXIMUM_PLANNER_RESPONSE_CALLS}`,
          `Maximum future model calls this plan may estimate: ${availableExecutionModelCalls}`,
          `Completed Ark turns already consumed: ${alreadyConsumedArkApiTurns}`,
          `Maximum future Ark turns this plan may estimate: ${availableExecutionArkApiTurns}`,
          `Maximum continuation segments per worker task: ${maximumWorkerSegments}`,
          `Maximum cumulative Ark turns one worker task may require across its fresh checkpoint segments: ${maximumTaskArkTurns}`,
          `Maximum cumulative input tokens one worker task may require across its fresh checkpoint segments: ${maximumTaskInputTokens}`,
          `estimatedCalls counts top-level Codex executions after planning. The control plane recalculates estimatedArkApiTurns as the sum of explicit task estimates plus a ${PLAN_VERIFICATION_RECOVERY_ARK_TURN_RESERVE}-turn verification/recovery reserve.`,
          `Return estimatedCalls no greater than ${availableExecutionModelCalls}. Plan the complete confirmed scope within that allowance by minimizing handoffs, combining tightly coupled work, and preferring deterministic tools and checks where they do not require a model call. Do not drop or weaken confirmed requirements to meet the budget.`,
          `Return estimatedArkApiTurns no greater than ${availableExecutionArkApiTurns}. Keep every task within its continuation capacity.`,
          "Choose the graph by total execution efficiency: use one task when delegation overhead would dominate; multiple sequential tasks when specialization helps but ordering is required; parallel tasks when they are genuinely independent; and hybrid dependency waves when both apply. Parallelism is enabled, never forced.",
          "allowedPaths are WRITE scopes only, not read/context scopes. Workers may read the staged workspace. Tasks with overlapping allowedPaths are valid: the control plane automatically places them in different execution waves. Add dependsOn only when a task must consume another task's output; do not add dependencies merely to prevent simultaneous writes.",
          "Maximize useful concurrency without fragmenting tightly coupled work. Minimize handoffs and the critical path. A dependent worker receives the integrated output of every completed prior wave.",
          input.orchestration.requestedMode === "direct"
            ? "The user selected Direct mode; return the smallest coherent task graph and the control plane will combine it for direct execution."
            : "The user allows adaptive orchestration. Do not create artificial tasks or dependencies to force either single-worker or multi-worker execution.",
          "Keep task objectives concise and implementation-focused. Do not repeat the full contract. Give each task its own estimatedArkApiTurns and estimatedInputTokens. If a task exceeds its continuation capacity, split it before returning the plan.",
          "When the contract restricts all edits to one explicit file, return exactly one task covering that file.",
          "Protect configuration secrets: allowedPaths must never include .env, .env.local, .env.production, or any other real environment file at any directory depth. Non-secret templates named exactly .env.example, .env.sample, or .env.template are allowed.",
          "Return this exact JSON shape with no additional task fields:",
          '{"coupling":"low|medium|high","estimatedCalls":8,"estimatedArkApiTurns":40,"estimatedContextTokens":12000,"tasks":[{"title":"short title","objective":"bounded objective","dependsOn":[],"allowedPaths":["repository/relative/write/path"],"acceptanceCriterionIds":["exact confirmed criterion ID"],"requiredArtifactIds":[],"estimatedArkApiTurns":12,"estimatedInputTokens":120000}]}',
          "dependsOn contains zero-based indexes of earlier tasks only. allowedPaths must be repository-relative, must never begin with /workspace or contain '..', and must follow the environment-file rule above. Use exact criterion IDs from the confirmed contract.",
        ].join("\n"),
      },
      planSchema(
        availableExecutionModelCalls,
        availableExecutionArkApiTurns,
        maximumTaskArkTurns,
        maximumTaskInputTokens,
      ),
      {
        instructions: [
          "Repair only the listed structural, safety, dependency, capacity, or budget problems in this compact task graph.",
          "Preserve correct confirmed scope. Parallelism is optional, and overlapping write scopes are valid because the scheduler serializes those workers.",
        ],
      },
    );
    result.value.estimatedArkApiTurns = deterministicPlanArkApiTurns(result.value);
    const acceptanceTests = comprehensiveAcceptanceTests([], input.contract);
    await this.verification.saveAcceptancePlan({
      orchestrationId: input.orchestration.id,
      contractVersion: input.contract.version,
      generatedBy: "control-plane",
      tests: acceptanceTests,
    });
    for (const test of acceptanceTests) {
      await sink.publishArtifact({
        id: this.newId(),
        orchestrationId: input.orchestration.id,
        producerTaskId: "control-plane",
        kind: "decision",
        name: `Contract acceptance test: ${test.id}`,
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
      actorRole: "control-plane",
      modelId: null,
      summary: "Control plane derived protected acceptance tests from the confirmed contract",
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
      maximumParallelWorkers: maximumTaskWaveWidth(result.value.tasks),
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
    if (route.selectedMode === "direct" && tasks.length > 1) {
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
        selectedMode: route.selectedMode,
        taskCount: tasks.length,
        estimatedCalls: result.value.estimatedCalls,
        estimatedArkApiTurns: result.value.estimatedArkApiTurns,
        availableExecutionModelCalls,
        availableExecutionArkApiTurns,
        maximumTaskArkTurns,
        maximumTaskInputTokens,
        maximumParallelWorkers: maximumTaskWaveWidth(result.value.tasks),
        alreadyConsumedModelCalls,
        reservedPlanningModelCalls: MAXIMUM_PLANNER_RESPONSE_CALLS,
      },
    });
    return { selectedMode: route.selectedMode, routeReason: route.reason, tasks, applicationMap: map.summary };
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
    let executionStage: ExecutionStage | null = null;
    try {
      if (input.plan.selectedMode === "direct") {
        results.push(await this.runDirect(input, sink, roles, signal));
      } else {
        executionStage = await this.integrator.createExecutionStage(
          input.orchestration.id,
          input.workspacePath,
        );
        broker.useWorkspace(executionStage.path);
        const scheduledWaves = executionTaskWaves(input.plan.tasks);
        let batchNumber = 0;
        for (const ready of scheduledWaves) {
          if (signal.aborted) return { kind: "cancelled", reason: "Cancelled before worker batch" };
          for (const task of ready) {
            if (task.status === "stale" || task.requiredArtifactIds.length) await artifacts.refresh(task);
            task.status = "ready";
            await sink.upsertTask(task);
          }
          batchNumber += 1;
          await sink.recordEvent({
            orchestrationId: input.orchestration.id,
            taskId: null,
            executionId: null,
            type: "worker-batch-started",
            actorRole: "control-plane",
            modelId: null,
            summary: ready.length > 1
              ? `Started ${ready.length} independent workers in parallel`
              : "Started one dependency-ready worker",
            metadata: {
              batchNumber,
              workerCount: ready.length,
              parallel: ready.length > 1,
              taskIds: ready.map((task) => task.id).join(","),
            },
          });
          const batch = await Promise.all(
            ready.map((task) =>
              loop.run({
                orchestration: input.orchestration,
                contract: input.contract,
                task,
                tasks: input.plan.tasks,
                map,
                mainWorkspacePath: executionStage!.path,
                signal,
                deterministicPreflight: true,
              }),
            ),
          );
          results.push(...batch);
          await this.integrator.applyExecutionWave(
            executionStage,
            batch.map((worker) => ({
              taskId: worker.task.id,
              workspacePath: worker.workspace.path,
              changes: worker.changes,
            })),
          );
          await sink.recordEvent({
            orchestrationId: input.orchestration.id,
            taskId: null,
            executionId: null,
            type: "worker-batch-staged",
            actorRole: "control-plane",
            modelId: null,
            summary: "Applied the completed wave to the private staged workspace",
            metadata: {
              batchNumber,
              taskIds: ready.map((task) => task.id).join(","),
              changedFiles: batch.reduce((count, worker) => count + worker.changes.changedFiles.length, 0),
            },
          });
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
        await this.workspaces.cleanupOrchestration(input.orchestration.id, "clean");
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
      await this.integrator.discardExecutionStage(input.orchestration.id).catch(() => undefined);
      this.activeRoles.delete(input.orchestration.id);
    }
  }

  async cancel(orchestrationId: string): Promise<boolean> {
    return (await this.activeRoles.get(orchestrationId)?.cancelOrchestration(orchestrationId)) ?? false;
  }

  resumeConnection(orchestrationId: string): boolean {
    return this.activeRoles.get(orchestrationId)?.retryNow(orchestrationId) ?? false;
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
      this.options.modelTransportRetryPolicy,
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
      const verification = await this.verification.run(
        input.orchestration.id,
        null,
        candidate.path,
        ["protected", "global", "manual"],
        sink,
        signal,
      );
      const plannedVerification = await this.runPlannedAcceptanceVerification(
        input,
        roles,
        candidate.path,
        sink,
        signal,
        verification,
        verifierGuidance
          ? { round: recoveryRound, instructions: verifierGuidance, history: recoveryHistory }
          : undefined,
      );
      const records = [...verification, ...plannedVerification];
      if (requiredVerificationPassed(records)) return { kind: "verified", candidate };

      const evidence = recoveryEvidence(records);
      const decision = await this.requestRecoveryDecision(
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
      const outcome = this.recoveryOutcome(
        input,
        decision,
        evidence,
        recoveryRound >= maximumRecoveryRounds,
      );
      if (outcome) {
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
    const resultsByTask = new Map(results.map((result) => [result.task.id, result]));
    const integrationWaves = executionTaskWaves(input.plan.tasks).map((wave) =>
      wave.map((task) => {
        const result = resultsByTask.get(task.id);
        if (!result) throw new Error(`Missing worker result for task ${task.id}`);
        return {
          taskId: result.task.id,
          workspacePath: result.workspace.path,
          changes: result.changes,
        };
      })
    );
    const candidate = await this.integrator.integrateWaves(
      input.orchestration.id,
      input.workspacePath,
      integrationWaves,
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
        maxArkApiTurns: Math.min(8, input.orchestration.budget.maxArkApiTurnsPerExecution ?? 8),
        maxInputTokens: Math.min(120_000, input.orchestration.budget.maxInputTokensPerExecution ?? 120_000),
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
      allowedWritePaths: result.task.allowedPaths,
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
    if (violations.length) throw new Error(`Direct recovery scope violation: ${violations.join(", ")}`);
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
        allowedWritePaths: result.task.allowedPaths,
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
      if (violations.length) throw new Error(`Recovery worker scope violation: ${violations.join(", ")}`);
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
      allowedWritePaths: allowedPaths,
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
    if (violations.length) throw new Error(`Recovery integrator scope violation: ${violations.join(", ")}`);
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
      allowedWritePaths: task.allowedPaths,
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
    if (violations.length) throw new Error(`Direct execution scope violation: ${violations.join(", ")}`);
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
    const evidenceBundle = {
      workspace: candidateMap.summary,
      files: candidateMap.entries.slice(0, 250).map((entry) => ({
        path: entry.path,
        bytes: entry.bytes,
        imports: entry.imports.slice(0, 20),
        exports: entry.exports.slice(0, 20),
        summary: entry.summary.slice(0, 500),
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
    };
    const compactAutomated = automated.map((test) => ({
      ...test,
      procedure: test.procedure.slice(0, 1_500),
      expectedOutcome: test.expectedOutcome.slice(0, 900),
    }));
    const evidenceArtifactId = this.newId();
    await sink.publishArtifact({
      id: evidenceArtifactId,
      orchestrationId: input.orchestration.id,
      producerTaskId: "verifier",
      kind: "test-result",
      name: "Deterministic verification evidence",
      version: input.contract.version,
      payload: JSON.stringify(evidenceBundle).slice(0, 40_000),
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
              "Start from the deterministic evidence bundle. Do not rediscover listed files. Inspect additional file contents only for acceptance tests that the supplied evidence cannot decide.",
              "Batch related non-destructive tests, type checks, builds, and static checks into at most three shell invocations. Keep successful output summarized and include only relevant failure lines.",
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
            ].join("\n").slice(0, 80_000),
            maxArkApiTurns: input.orchestration.budget.maxArkApiTurnsPerExecution,
            maxInputTokens: input.orchestration.budget.maxInputTokensPerExecution,
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
        id: this.newId(),
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
    const resultArtifactId = this.newId();
    await sink.publishArtifact({
      id: resultArtifactId,
      orchestrationId: input.orchestration.id,
      producerTaskId: "verifier",
      kind: "test-result",
      name: "Acceptance verification results",
      version: input.contract.version,
      payload: JSON.stringify(records.map((record) => ({
        check: record.commandOrCheck,
        status: record.status,
        evidence: record.outputSummary.slice(0, 1_500),
      }))).slice(0, 40_000),
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
        recoveryRound: recovery?.round ?? 0,
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
