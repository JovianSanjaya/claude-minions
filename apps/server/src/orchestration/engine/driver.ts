import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionOutcome,
  IntentDraft,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  PlanInput,
  PlanResult,
  TokenUsage,
} from "../contracts.js";
import type { AgentRunner } from "../../types.js";
import { buildApplicationMap, type DetailedApplicationMap } from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { classifyFailure } from "./failure-packet.js";
import { DeterministicIntegrator } from "./integrator.js";
import { RoleExecutor, type RoleModelConfiguration } from "./role-executor.js";
import { selectRoute } from "./router.js";
import { requiredVerificationPassed, type TrustedVerificationCheck, VerificationService } from "./verification.js";
import { BoundedWorkerLoop, type WorkerLoopResult, WorkerLoopError } from "./worker-loop.js";
import { scopeViolations, WorkerWorkspaceManager } from "./worker-workspaces.js";

const intentSchema = z.object({
  goal: z.string().min(1).max(8_000),
  requirements: z.array(z.string().min(1).max(4_000)).min(1).max(100),
  assumptions: z.array(z.string().max(4_000)).max(100),
  nonGoals: z.array(z.string().max(4_000)).max(100),
  architectureDecisions: z.array(z.string().max(4_000)).max(100),
  materialQuestions: z.array(z.string().max(4_000)).max(50),
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

const planSchema = z.object({
  coupling: z.preprocess((value) => typeof value === "string" ? value.toLowerCase() : value, z.enum(["low", "medium", "high"])),
  estimatedCalls: z.coerce.number().int().positive().max(500),
  estimatedContextTokens: z.coerce.number().int().nonnegative(),
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    objective: z.string().min(1).max(4_000),
    dependsOn: z.array(z.coerce.number().int().nonnegative()).max(50).default([]),
    allowedPaths: z.array(z.string().min(1).max(500)).min(1).max(100),
    acceptanceCriterionIds: z.array(z.string().max(200)).max(100).default([]),
    requiredArtifactIds: z.array(z.string().max(200)).max(100).default([]),
  })).min(1).max(20),
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
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

function safeAllowedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.startsWith(".env")) {
    throw new Error(`Planner produced unsafe allowed path: ${value}`);
  }
  return normalized;
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
          "Return goal, requirements, assumptions, nonGoals, architectureDecisions, materialQuestions, manualExpectations, and estimate.",
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
        materialQuestions: result.value.materialQuestions,
        manualExpectations: result.value.manualExpectations,
        createdAt,
      },
      estimate: result.value.estimate,
    };
  }

  async plan(input: PlanInput, sink: OrchestrationSink, signal: AbortSignal): Promise<PlanResult> {
    const map = await buildApplicationMap(input.workspacePath, input.orchestration.id, 1, this.now());
    this.maps.set(input.orchestration.id, map);
    await sink.recordApplicationMap(map.summary);
    const roles = this.roles(input.orchestration.id, sink);
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
          "Create a bounded coding plan for the explicitly confirmed contract. Do not edit files.",
          `Contract: ${JSON.stringify(input.contract)}`,
          `Application map: ${JSON.stringify({ summary: map.summary, entries: map.entries.map((entry) => ({ path: entry.path, imports: entry.imports, exports: entry.exports, summary: entry.summary })) })}`,
          "Return this exact JSON shape with no additional task fields:",
          '{"coupling":"low|medium|high","estimatedCalls":8,"estimatedContextTokens":12000,"tasks":[{"title":"short title","objective":"bounded objective","dependsOn":[],"allowedPaths":["repository/relative/path"],"acceptanceCriterionIds":["exact confirmed criterion ID"],"requiredArtifactIds":[]}]}',
          "dependsOn contains zero-based indexes of earlier tasks only. allowedPaths must be repository-relative and must never begin with /workspace or contain '..'. Use exact criterion IDs from the confirmed contract.",
        ].join("\n").slice(0, 150_000),
      },
      planSchema,
    );
    const route = selectRoute({
      requestedMode: input.orchestration.requestedMode,
      taskCount: result.value.tasks.length,
      changedAreaCount: new Set(result.value.tasks.flatMap((task) => task.allowedPaths.map((entry) => entry.split("/")[0]))).size,
      coupling: result.value.coupling,
      estimatedCalls: result.value.estimatedCalls,
      estimatedContextTokens: result.value.estimatedContextTokens,
      budget: input.orchestration.budget,
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
    if (route.selectedMode !== "multi-worker" && tasks.length > 1) {
      tasks = [{
        id: this.newId(),
        orchestrationId: input.orchestration.id,
        title: route.selectedMode === "direct" ? "Direct confirmed execution" : "Focused combined worker",
        objective: tasks.map((task) => task.objective).join("; "),
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
      metadata: { selectedMode: route.selectedMode, taskCount: tasks.length },
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
              }),
            ),
          );
          results.push(...batch);
          for (const task of ready) remaining.delete(task.id);
        }
      }

      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: "integration-step",
        actorRole: "control-plane",
        modelId: null,
        summary: "Started deterministic-first integration",
        metadata: { workerResultCount: results.length },
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
                ...conflict.variants.map((variant) => `Task ${variant.taskId}:\n${variant.content.toString("utf8").slice(0, 30_000)}`),
                "Return JSON with content only.",
              ].join("\n"),
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
        metadata: { changedFiles: candidate.changes.changedFiles.length, conflicts: candidate.conflicts.length },
      });
      const verification = await this.verification.run(
        input.orchestration.id,
        null,
        candidate.path,
        ["protected", "global", "manual"],
        sink,
        signal,
      );
      if (!requiredVerificationPassed(verification)) {
        await this.integrator.cleanup(candidate);
        await this.cleanup(results, "archive");
        await this.workspaces.cleanupOrchestration(input.orchestration.id, "clean");
        return { kind: "failed", reason: "Protected or global verification failed; main workspace was not changed" };
      }
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
              amendment: this.amendment(input, diagnosis.value.reason),
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

  private roles(orchestrationId: string, sink: OrchestrationSink): RoleExecutor {
    const existing = this.activeRoles.get(orchestrationId);
    if (existing) return existing;
    const roles = new RoleExecutor(
      this.options.runner,
      sink,
      this.options.models,
      this.options.runtimeHomeRoot,
      this.newId,
    );
    this.activeRoles.set(orchestrationId, roles);
    return roles;
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
      prompt: `Execute the confirmed direct task in the workspace. Edit only ${task.allowedPaths.join(", ")}. Contract: ${JSON.stringify(input.contract)}`,
    });
    const changes = await this.workspaces.changes(workspace);
    const violations = scopeViolations(changes, task.allowedPaths);
    if (violations.length) throw new Error(`Direct execution scope violation: ${violations.join(", ")}`);
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

  private amendment(input: ExecuteInput, reason: string): ContractAmendment {
    const now = this.now().toISOString();
    return {
      id: this.newId(),
      orchestrationId: input.orchestration.id,
      baseContractId: input.contract.id,
      proposedIntent: {
        ...structuredClone(input.contract.intent),
        id: this.newId(),
        revision: input.contract.intent.revision + 1,
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

  private async cleanup(
    results: WorkerLoopResult[],
    policy: "clean" | "archive" | "retain",
  ): Promise<void> {
    await Promise.all(results.map((result) => this.workspaces.cleanup(result.workspace, policy)));
  }
}
