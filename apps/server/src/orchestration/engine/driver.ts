import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionContract,
  ExecutionOutcome,
  IntentDraft,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  PlanInput,
  PlanResult,
  TokenUsage,
  WorkerAttempt,
} from "../contracts.js";
import type { AgentRunner } from "../../types.js";
import { ApplicationMapBuilder, type ApplicationMap } from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { classifyFailure, type FailureClassification } from "./failure-packet.js";
import { Integrator, type IntegratableWorkerResult } from "./integrator.js";
import { PreflightService } from "./preflight.js";
import { BudgetDeniedError, RoleExecutor, type RoleModels } from "./role-executor.js";
import { RoutingError, selectExecutionRoute } from "./router.js";
import {
  VerificationService,
  type TrustedVerificationCheck,
  type VerificationExecutor,
} from "./verification.js";
import { WorkerLoop, type WorkerTaskResult } from "./worker-loop.js";
import { WorkerWorkspaceManager, type WorkerWorkspace } from "./worker-workspaces.js";

const intentSchema = z
  .object({
    goal: z.string().min(1).max(4_000),
    requirements: z.array(z.string().min(1).max(2_000)).min(1).max(50),
    assumptions: z.array(z.string().min(1).max(2_000)).max(50),
    nonGoals: z.array(z.string().min(1).max(2_000)).max(50),
    architectureDecisions: z.array(z.string().min(1).max(2_000)).max(50),
    materialQuestions: z.array(z.string().min(1).max(2_000)).max(20),
    manualExpectations: z.array(z.string().min(1).max(2_000)).max(30),
    estimate: z
      .object({
        inputTokenLow: z.number().int().nonnegative(),
        inputTokenHigh: z.number().int().nonnegative(),
        outputTokenLow: z.number().int().nonnegative(),
        outputTokenHigh: z.number().int().nonnegative(),
        estimatedUsdLow: z.number().nonnegative().nullable(),
        estimatedUsdHigh: z.number().nonnegative().nullable(),
        assumptions: z.array(z.string().min(1).max(1_000)).max(20),
      })
      .strict(),
  })
  .strict();

const planSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/),
            title: z.string().min(1).max(200),
            objective: z.string().min(1).max(3_000),
            dependsOn: z.array(z.string().min(1).max(80)).max(20),
            allowedPaths: z.array(z.string().min(1).max(300)).min(1).max(100),
            acceptanceCriterionIds: z.array(z.string().min(1).max(200)).max(100),
            requiredArtifactIds: z.array(z.string().min(1).max(200)).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

const escalationSchema = z
  .object({
    classification: z.enum([
      "implementation-bug",
      "missing-context",
      "stale-dependency",
      "weak-model",
      "invalid-plan",
      "ambiguous-contract",
      "suspected-bad-check",
      "budget-exhaustion",
    ]),
    action: z.enum(["stop", "needs-user"]),
    reason: z.string().min(1).max(2_000),
  })
  .strict();

export interface ExecutionEngineOptions {
  runner: AgentRunner;
  models: RoleModels;
  baseModelId: string;
  modelOverrideSupported?: boolean;
  pricingConfigured?: boolean;
  runtimeHomeRoot: string;
  tempWorkspaceRoot: string;
  archiveWorkspaceRoot: string;
  protectedEvaluatorRoot: string;
  verificationChecks: TrustedVerificationCheck[];
  verificationExecutor?: VerificationExecutor;
  failureWorkspacePolicy?: "clean" | "archive";
  idProvider?: () => string;
}

function safeTaskId(orchestrationId: string, key: string): string {
  return `${orchestrationId}-task-${key}`;
}

function validateAllowedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Planner returned unsafe allowed path: ${value}`);
  }
  return normalized;
}

function compactPlanMap(map: ApplicationMap): string {
  return [
    map.summary.summary,
    `Repository hash: ${map.summary.repositoryHash}`,
    `Files:\n${map.files.slice(0, 1_000).map((file) => `${file.path} (${file.bytes} bytes)`).join("\n")}`,
    `Modules:\n${map.moduleSummaries.join("\n")}`,
  ].join("\n\n");
}

function combineTasks(
  orchestrationId: string,
  tasks: OrchestrationTask[],
  mode: "direct" | "one-worker",
): OrchestrationTask[] {
  return [
    {
      id: `${orchestrationId}-${mode}`,
      orchestrationId,
      title: mode === "direct" ? "Direct confirmed execution" : "Focused combined worker",
      objective: tasks.map((task) => task.objective).join("\n"),
      status: "ready",
      dependsOn: [],
      allowedPaths: [...new Set(tasks.flatMap((task) => task.allowedPaths))],
      acceptanceCriterionIds: [
        ...new Set(tasks.flatMap((task) => task.acceptanceCriterionIds)),
      ],
      requiredArtifactIds: [...new Set(tasks.flatMap((task) => task.requiredArtifactIds))],
      observedArtifactVersions: {},
      applicationMapVersion: tasks[0]?.applicationMapVersion ?? 1,
      attemptCount: 0,
    },
  ];
}

export class ContextAwareExecutionDriver implements OrchestrationExecutionDriver {
  private readonly maps = new ApplicationMapBuilder();
  private readonly artifacts = new ArtifactRegistry();
  private readonly broker = new ContextBroker();
  private readonly roles: RoleExecutor;
  private readonly workspaces: WorkerWorkspaceManager;
  private readonly verification: VerificationService;
  private readonly preflights: PreflightService;
  private readonly workerLoop: WorkerLoop;
  private readonly integrator: Integrator;
  private readonly active = new Set<string>();
  private readonly idProvider: () => string;

  constructor(private readonly options: ExecutionEngineOptions) {
    this.idProvider = options.idProvider ?? randomUUID;
    this.roles = new RoleExecutor({
      runner: options.runner,
      models: options.models,
      baseModelId: options.baseModelId,
      modelOverrideSupported: options.modelOverrideSupported ?? false,
      runtimeHomeRoot: options.runtimeHomeRoot,
      idProvider: this.idProvider,
    });
    this.workspaces = new WorkerWorkspaceManager(
      options.tempWorkspaceRoot,
      options.archiveWorkspaceRoot,
    );
    this.verification = new VerificationService(
      options.protectedEvaluatorRoot,
      options.verificationChecks,
      options.verificationExecutor,
    );
    this.preflights = new PreflightService(this.roles, this.broker);
    this.workerLoop = new WorkerLoop(
      this.roles,
      this.broker,
      this.preflights,
      this.workspaces,
      this.verification,
      this.artifacts,
    );
    this.integrator = new Integrator(this.roles, this.workspaces, this.verification);
  }

  async elaborateIntent(
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<{ draft: IntentDraft; estimate: CostEstimate }> {
    const result = await this.roles.callStructured(
      {
        orchestrationId: input.orchestrationId,
        taskId: null,
        agentId: input.agentId,
        role: "planner",
        prompt: [
          "Elaborate the user's coding intent without editing files or creating a plan.",
          "Identify material assumptions and unresolved questions before any delegated coding.",
          "Give a conservative token range. Dollar values must be null when pricing is not configured.",
          `Requested mode: ${input.requestedMode}`,
          `Hard budget: ${JSON.stringify(input.budget)}`,
          `Pricing configured: ${this.options.pricingConfigured === true}`,
          `User prompt: ${input.prompt}`,
          "Return only the required JSON object; do not include reasoning.",
        ].join("\n\n"),
        workspacePath: input.workspacePath,
        sandboxMode: "read-only",
        estimatedInputTokens: Math.ceil(input.prompt.length / 4) + 1_000,
        estimatedOutputTokens: 1_500,
        sink,
        signal,
      },
      intentSchema,
      "{goal:string,requirements:string[],assumptions:string[],nonGoals:string[],architectureDecisions:string[],materialQuestions:string[],manualExpectations:string[],estimate:{inputTokenLow:number,inputTokenHigh:number,outputTokenLow:number,outputTokenHigh:number,estimatedUsdLow:number|null,estimatedUsdHigh:number|null,assumptions:string[]}}",
    );
    const timestamp = new Date().toISOString();
    const draft: IntentDraft = {
      id: this.idProvider(),
      orchestrationId: input.orchestrationId,
      revision: 1,
      goal: result.value.goal,
      requirements: result.value.requirements,
      assumptions: result.value.assumptions,
      nonGoals: result.value.nonGoals,
      architectureDecisions: result.value.architectureDecisions,
      materialQuestions: result.value.materialQuestions,
      manualExpectations: result.value.manualExpectations,
      createdAt: timestamp,
    };
    const priced = this.options.pricingConfigured === true;
    const estimate: CostEstimate = {
      inputTokenLow: result.value.estimate.inputTokenLow,
      inputTokenHigh: Math.max(
        result.value.estimate.inputTokenLow,
        result.value.estimate.inputTokenHigh,
      ),
      outputTokenLow: result.value.estimate.outputTokenLow,
      outputTokenHigh: Math.max(
        result.value.estimate.outputTokenLow,
        result.value.estimate.outputTokenHigh,
      ),
      estimatedUsdLow: priced ? result.value.estimate.estimatedUsdLow : null,
      estimatedUsdHigh: priced ? result.value.estimate.estimatedUsdHigh : null,
      pricingStatus: priced ? "configured" : "unknown",
      assumptions: result.value.estimate.assumptions,
    };
    return { draft, estimate };
  }

  async plan(
    input: PlanInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<PlanResult> {
    const map = await this.maps.build(input.orchestration.id, input.workspacePath, { version: 1 });
    await sink.recordApplicationMap(map.summary);
    const result = await this.roles.callStructured(
      {
        orchestrationId: input.orchestration.id,
        taskId: null,
        agentId: input.orchestration.agentId,
        role: "planner",
        prompt: [
          "Create a detailed implementation decomposition only from the user-confirmed contract and deterministic application map.",
          "Use normalized workspace-relative allowed paths. Dependencies must reference task keys.",
          "Share typed artifacts, never worker transcripts. Do not edit files.",
          `Confirmed contract v${input.contract.version}: ${JSON.stringify(input.contract.criteria)}`,
          compactPlanMap(map),
          "Return only the required JSON object; do not include reasoning.",
        ].join("\n\n"),
        workspacePath: input.workspacePath,
        sandboxMode: "read-only",
        estimatedInputTokens: Math.ceil(compactPlanMap(map).length / 4) + 2_000,
        estimatedOutputTokens: 2_500,
        sink,
        signal,
      },
      planSchema,
      "{tasks:{key:string,title:string,objective:string,dependsOn:string[],allowedPaths:string[],acceptanceCriterionIds:string[],requiredArtifactIds:string[]}[]}",
    );
    const knownCriteria = new Set(input.contract.criteria.map((criterion) => criterion.id));
    const keyToId = new Map(
      result.value.tasks.map((task) => [task.key, safeTaskId(input.orchestration.id, task.key)]),
    );
    let tasks: OrchestrationTask[] = result.value.tasks.map((task) => ({
      id: keyToId.get(task.key)!,
      orchestrationId: input.orchestration.id,
      title: task.title,
      objective: task.objective,
      status: task.dependsOn.length > 0 ? "blocked" : "ready",
      dependsOn: task.dependsOn.map((key) => {
        const dependency = keyToId.get(key);
        if (!dependency) throw new Error(`Planner returned unknown dependency key: ${key}`);
        return dependency;
      }),
      allowedPaths: task.allowedPaths.map(validateAllowedPath),
      acceptanceCriterionIds: task.acceptanceCriterionIds.map((criterionId) => {
        if (!knownCriteria.has(criterionId)) {
          throw new Error(`Planner returned unknown acceptance criterion: ${criterionId}`);
        }
        return criterionId;
      }),
      requiredArtifactIds: task.requiredArtifactIds,
      observedArtifactVersions: {},
      applicationMapVersion: map.summary.version,
      attemptCount: 0,
    }));
    const route = selectExecutionRoute({
      requestedMode: input.orchestration.requestedMode,
      tasks,
      criterionCount: input.contract.criteria.length,
      applicationFileCount: map.summary.fileCount,
      budget: input.orchestration.budget,
    });
    if (route.selectedMode !== "multi-worker") {
      tasks = combineTasks(input.orchestration.id, tasks, route.selectedMode);
    }
    for (const task of tasks) await sink.upsertTask(task);
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: result.executionId,
      type: "route.selected",
      actorRole: "planner",
      modelId: result.modelId,
      summary: route.reason,
      metadata: { selectedMode: route.selectedMode, taskCount: tasks.length },
    });
    return {
      selectedMode: route.selectedMode,
      routeReason: route.reason,
      tasks,
      applicationMap: map.summary,
    };
  }

  async execute(
    input: ExecuteInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    if (this.active.has(input.orchestration.id)) {
      return { kind: "failed", reason: "Orchestration execution is already active" };
    }
    this.active.add(input.orchestration.id);
    const retained: WorkerWorkspace[] = [];
    let successful = false;
    let wallClockExceeded = false;
    let remainingSteps = input.orchestration.budget.maxSteps;
    const executionController = new AbortController();
    const forwardCancellation = () => executionController.abort(signal.reason);
    signal.addEventListener("abort", forwardCancellation, { once: true });
    const wallClockTimer = setTimeout(() => {
      wallClockExceeded = true;
      executionController.abort(new Error("Orchestration wall-clock budget exhausted"));
    }, input.orchestration.budget.maxWallClockMs);
    wallClockTimer.unref();
    const executionSignal = executionController.signal;
    try {
      if (remainingSteps < 1) {
        return { kind: "budget-exhausted", reason: "Hard step budget exhausted before execution" };
      }
      const map = await this.maps.build(input.orchestration.id, input.workspacePath, {
        version: input.plan.applicationMap.version,
      });
      if (map.summary.repositoryHash !== input.plan.applicationMap.repositoryHash) {
        return { kind: "needs-user", amendment: this.amendment(input.contract, "The workspace changed after planning; confirm a refreshed contract and plan.") };
      }
      if (input.plan.selectedMode === "direct") {
        remainingSteps -= 1;
        const outcome = await this.executeDirect(input, map, sink, executionSignal, retained);
        successful = outcome.kind === "completed";
        return wallClockExceeded
          ? { kind: "budget-exhausted", reason: "Orchestration wall-clock budget exhausted" }
          : outcome;
      }

      const passed: IntegratableWorkerResult[] = [];
      const completed = new Set<string>();
      while (completed.size < input.plan.tasks.length) {
        if (executionSignal.aborted) {
          return wallClockExceeded
            ? { kind: "budget-exhausted", reason: "Orchestration wall-clock budget exhausted" }
            : { kind: "cancelled", reason: "Orchestration cancelled" };
        }
        const next = input.plan.tasks.find(
          (task) =>
            !completed.has(task.id) &&
            task.dependsOn.every((dependency) => completed.has(dependency)),
        );
        if (!next) return { kind: "failed", reason: "Task dependency graph is cyclic or blocked" };
        if (next.status === "stale") {
          await this.artifacts.refreshTask(next, input.orchestration.id, sink);
        } else if (next.status === "blocked") {
          next.status = "ready";
          await sink.upsertTask(next);
        }
        if (remainingSteps <= 1) {
          return { kind: "budget-exhausted", reason: "Hard step budget exhausted before the next worker attempt" };
        }
        const allowedAttempts = Math.min(
          input.orchestration.budget.maxWorkerAttempts,
          remainingSteps - 1,
        );
        const result = await this.workerLoop.execute({
          orchestrationId: input.orchestration.id,
          agentId: input.orchestration.agentId,
          task: next,
          allTasks: input.plan.tasks,
          contract: input.contract,
          map,
          sink,
          signal: executionSignal,
          maxAttempts: allowedAttempts,
          maxContextExpansions: input.orchestration.budget.maxContextExpansionsPerTask,
        });
        remainingSteps -= 1 + next.attemptCount;
        if (result.workspace) retained.push(result.workspace);
        if (result.kind === "budget-exhausted") {
          return { kind: "budget-exhausted", reason: result.reason };
        }
        if (result.kind === "cancelled") {
          return wallClockExceeded
            ? { kind: "budget-exhausted", reason: "Orchestration wall-clock budget exhausted" }
            : { kind: "cancelled", reason: result.reason };
        }
        if (result.kind === "failed") {
          return await this.escalate(input, result, sink, executionSignal);
        }
        passed.push({ task: result.task, workspace: result.workspace, manifest: result.manifest });
        completed.add(result.task.id);
      }
      const integrated = await this.integrator.integrate({
        orchestrationId: input.orchestration.id,
        agentId: input.orchestration.agentId,
        contract: input.contract,
        map,
        workers: passed,
        sink,
        signal: executionSignal,
      });
      const outcome = this.integrationOutcome(input.contract, integrated);
      successful = outcome.kind === "completed";
      return outcome;
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        return { kind: "budget-exhausted", reason: error.reason };
      }
      if (error instanceof RoutingError) return { kind: "failed", reason: error.message };
      if (executionSignal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return wallClockExceeded
          ? { kind: "budget-exhausted", reason: "Orchestration wall-clock budget exhausted" }
          : { kind: "cancelled", reason: "Orchestration cancelled" };
      }
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(wallClockTimer);
      signal.removeEventListener("abort", forwardCancellation);
      this.active.delete(input.orchestration.id);
      const policy = successful ? "clean" : (this.options.failureWorkspacePolicy ?? "archive");
      for (const workspace of retained) {
        const result = await this.workspaces.cleanup(workspace, policy).catch(() => null);
        await sink
          .recordEvent({
            orchestrationId: input.orchestration.id,
            taskId: workspace.taskId,
            executionId: null,
            type: result?.disposition === "archived" ? "workspace.archived" : "workspace.cleaned",
            actorRole: "control-plane",
            modelId: null,
            summary: result
              ? `Temporary worker workspace ${result.disposition}.`
              : "Temporary workspace cleanup was rejected or failed; retained for manual review.",
            metadata: { disposition: result?.disposition ?? "retained" },
          })
          .catch(() => undefined);
      }
    }
  }

  async cancel(orchestrationId: string): Promise<boolean> {
    return this.roles.cancel(orchestrationId);
  }

  private async executeDirect(
    input: ExecuteInput,
    map: ApplicationMap,
    sink: OrchestrationSink,
    signal: AbortSignal,
    retained: WorkerWorkspace[],
  ): Promise<ExecutionOutcome> {
    const task = input.plan.tasks[0];
    if (!task) return { kind: "failed", reason: "Direct plan did not contain a task" };
    const context = await this.broker.createPacket({
      map,
      task,
      contract: input.contract,
      artifacts: [],
      sink,
    });
    const workspace = await this.workspaces.create(
      input.orchestration.id,
      task,
      map,
      context.sources.map((source) => source.path),
    );
    retained.push(workspace);
    const response = await this.roles.callText({
      orchestrationId: input.orchestration.id,
      taskId: task.id,
      agentId: input.orchestration.agentId,
      role: "planner",
      prompt: [
        "Execute the user-confirmed task directly in this isolated workspace.",
        `Goal: ${input.contract.intent.goal}`,
        `Criteria: ${input.contract.criteria.map((criterion) => `${criterion.id}: ${criterion.description}`).join(" | ")}`,
        `Allowed paths: ${task.allowedPaths.join(", ")}`,
        "Run appropriate visible checks and provide a concise final summary. Do not include hidden reasoning.",
      ].join("\n\n"),
      workspacePath: workspace.workspacePath,
      sandboxMode: "workspace-write",
      estimatedInputTokens: context.summary.estimatedTokens + 1_500,
      estimatedOutputTokens: 2_000,
      sink,
      signal,
    });
    const manifest = await this.workspaces.inspect(workspace);
    const attempt: WorkerAttempt = {
      id: this.idProvider(),
      orchestrationId: input.orchestration.id,
      taskId: task.id,
      number: 1,
      executionId: response.executionId,
      modelId: response.modelId,
      contextFileHashes: context.summary.sourceFiles.map((file) => file.sha256),
      changedFiles: manifest.files.map((file) => file.path),
      status: manifest.scopeViolations.length === 0 ? "passed" : "failed",
      usage: response.usage,
      errorSummary:
        manifest.scopeViolations.length === 0
          ? null
          : `Out-of-scope changes: ${manifest.scopeViolations.join(", ")}`,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    await sink.recordAttempt(attempt);
    if (manifest.scopeViolations.length > 0) {
      return { kind: "failed", reason: attempt.errorSummary ?? "Direct execution violated scope" };
    }
    const integrated = await this.integrator.integrate({
      orchestrationId: input.orchestration.id,
      agentId: input.orchestration.agentId,
      contract: input.contract,
      map,
      workers: [{ task, workspace, manifest }],
      sink,
      signal,
    });
    return this.integrationOutcome(input.contract, integrated, response.value);
  }

  private integrationOutcome(
    contract: ExecutionContract,
    result: Awaited<ReturnType<Integrator["integrate"]>>,
    modelSummary?: string,
  ): ExecutionOutcome {
    if (result.kind === "published") {
      return {
        kind: "completed",
        finalOutput: [modelSummary, result.summary].filter(Boolean).join("\n\n"),
      };
    }
    if (result.kind === "needs-user") {
      return { kind: "needs-user", amendment: this.amendment(contract, result.reason) };
    }
    return result;
  }

  private async escalate(
    input: ExecuteInput,
    result: Extract<WorkerTaskResult, { kind: "failed" }>,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const deterministic = classifyFailure(result.packet);
    try {
      const diagnosis = await this.roles.callStructured(
        {
          orchestrationId: input.orchestration.id,
          taskId: result.task.id,
          agentId: input.orchestration.agentId,
          role: "planner",
          prompt: [
            "Classify this compact bounded failure packet. Do not request worker transcripts.",
            "Choose needs-user only for a material ambiguity, suspected bad protected check, or contract change; otherwise stop safely.",
            `Deterministic hint: ${deterministic}`,
            JSON.stringify(result.packet),
          ].join("\n\n"),
          workspacePath: input.workspacePath,
          sandboxMode: "read-only",
          estimatedInputTokens: Math.ceil(JSON.stringify(result.packet).length / 4) + 500,
          estimatedOutputTokens: 500,
          sink,
          signal,
        },
        escalationSchema,
        "{classification:'implementation-bug'|'missing-context'|'stale-dependency'|'weak-model'|'invalid-plan'|'ambiguous-contract'|'suspected-bad-check'|'budget-exhaustion',action:'stop'|'needs-user',reason:string}",
      );
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: result.task.id,
        executionId: diagnosis.executionId,
        type: "failure.escalated",
        actorRole: "planner",
        modelId: diagnosis.modelId,
        summary: diagnosis.value.reason,
        metadata: {
          classification: diagnosis.value.classification,
          attempts: result.packet.attemptCount,
        },
      });
      if (diagnosis.value.action === "needs-user") {
        return {
          kind: "needs-user",
          amendment: this.amendment(input.contract, diagnosis.value.reason),
        };
      }
      return { kind: "failed", reason: diagnosis.value.reason };
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        return { kind: "budget-exhausted", reason: error.reason };
      }
      return {
        kind: "failed",
        reason: `Worker attempts exhausted (${deterministic}): ${result.packet.lastError}`,
      };
    }
  }

  private amendment(contract: ExecutionContract, reason: string): ContractAmendment {
    const timestamp = new Date().toISOString();
    return {
      id: this.idProvider(),
      orchestrationId: contract.orchestrationId,
      baseContractId: contract.id,
      proposedIntent: {
        ...contract.intent,
        id: this.idProvider(),
        revision: contract.intent.revision + 1,
        createdAt: timestamp,
      },
      proposedCriteria: null,
      reason: reason.slice(0, 4_000),
      material: true,
      status: "pending",
      createdAt: timestamp,
      decidedAt: null,
    };
  }
}

export type { FailureClassification };
