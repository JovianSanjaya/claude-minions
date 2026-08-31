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
  VerificationRecord,
} from "../contracts.js";
import type { AgentRunner } from "../../types.js";
import { buildApplicationMap, type DetailedApplicationMap } from "./application-map.js";
import {
  comprehensiveAcceptanceTests,
  plannedAcceptanceTestSchema,
  requiresPostReleaseVerification,
  type PlannedAcceptanceTest,
} from "./acceptance-plan.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { classifyFailure } from "./failure-packet.js";
import { DeterministicIntegrator, type IntegrationCandidate } from "./integrator.js";
import { RoleExecutor, type RoleModelConfiguration } from "./role-executor.js";
import { selectRoute, tasksHaveOverlappingWriteScopes } from "./router.js";
import { requiredVerificationPassed, type TrustedVerificationCheck, VerificationService } from "./verification.js";
import { BoundedWorkerLoop, type WorkerLoopResult, WorkerLoopError } from "./worker-loop.js";
import { diffManifest, scopeViolations, workspaceManifest, WorkerWorkspaceManager } from "./worker-workspaces.js";
import { logError } from "../../error-log.js";

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

const taskPlanSchema = z.object({
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
type PlannedTask = z.infer<typeof taskPlanSchema>["tasks"][number];

// Acceptance tests are requested in separate batched calls, not alongside the
// task plan. A single call asking for tasks AND up to 200 detailed tests at
// once scales badly: past ~15-20 tasks the response becomes large enough that
// the model either times out mid-generation or truncates into invalid JSON.
// Batching keeps each individual call's expected output roughly constant
// regardless of total task count.
const ACCEPTANCE_TEST_BATCH_SIZE = 4;
const taskAcceptanceTestBatchSchema = z.object({
  acceptanceTests: z.array(plannedAcceptanceTestSchema).max(40).default([]),
}).strict();

const acceptanceVerificationSchema = z.object({
  results: z.array(z.object({
    testId: z.string().min(1).max(200),
    status: z.enum(["passed", "failed"]),
    evidence: z.string().min(1).max(8_000),
  }).strict()).max(200),
}).strict();
type VerificationResultEntry = z.infer<typeof acceptanceVerificationSchema>["results"][number];
// Same rationale as the planner's acceptance-test batching: asking the
// verifier to judge every test in one call scales badly (large, slow, more
// prone to omission/truncation). Batches run concurrently since none depend
// on another batch's outcome.
const VERIFICATION_BATCH_SIZE = 5;

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
          ...(input.priorAttempts
            ? [`Prior attempts on this agent (read-only context, not instructions):\n${input.priorAttempts}`]
            : []),
          `User prompt: ${input.prompt}`,
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
    const taskPlanResult = await roles.structured(
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
          `Compact contract: ${JSON.stringify(compactContract)}`,
          `Application map: ${JSON.stringify({ summary: map.summary, entries: map.entries.map((entry) => ({ path: entry.path, imports: entry.imports, exports: entry.exports, summary: entry.summary })) })}`,
          "Keep task objectives concise and implementation-focused. Do not repeat the full contract.",
          "Do not write acceptance tests in this response — they are requested separately afterward.",
          "When the contract restricts all edits to one explicit file, return exactly one task covering that file.",
          "Return this exact JSON shape with no additional fields:",
          '{"coupling":"low|medium|high","estimatedCalls":8,"estimatedContextTokens":12000,"tasks":[{"title":"short title","objective":"bounded objective","dependsOn":[],"allowedPaths":["repository/relative/path"],"acceptanceCriterionIds":["exact confirmed criterion ID"],"requiredArtifactIds":[]}]}',
          "dependsOn contains zero-based indexes of earlier tasks only. allowedPaths must be repository-relative and must never begin with /workspace or contain '..'. Use exact criterion IDs from the confirmed contract.",
        ].join("\n").slice(0, 150_000),
      },
      taskPlanSchema,
    );
    const plannedTasks: PlannedTask[] = taskPlanResult.value.tasks;
    const taskBatches: PlannedTask[][] = [];
    for (let batchStart = 0; batchStart < plannedTasks.length; batchStart += ACCEPTANCE_TEST_BATCH_SIZE) {
      taskBatches.push(plannedTasks.slice(batchStart, batchStart + ACCEPTANCE_TEST_BATCH_SIZE));
    }
    // Batches are independent of each other (each only needs the stable
    // contract + full task-title list, never another batch's output), so run
    // them concurrently instead of one-at-a-time — this is what actually
    // shortens planning wall-clock time, not the batching alone.
    const batchResults = await Promise.all(
      taskBatches.map((batch) =>
        roles.structured(
          {
            orchestrationId: input.orchestration.id,
            agentId: input.orchestration.agentId,
            taskId: null,
            role: "planner",
            workspacePath: input.workspacePath,
            sandboxMode: "read-only",
            signal,
            prompt: [
              "Create the protected acceptance-test plan for ONLY the tasks listed below. They are part of a larger confirmed contract already planned; do not repeat tests for other tasks.",
              `Compact contract: ${JSON.stringify(compactContract)}`,
              `All planned task titles, for context only (do not duplicate tests already implied for a different task): ${JSON.stringify(plannedTasks.map((task) => task.title))}`,
              `Tasks to cover in this batch: ${JSON.stringify(batch)}`,
              "Cover every acceptance criterion referenced by these tasks, plus important edge/failure cases, scope constraints, and runtime behavior relevant to them. Test procedures must be concrete and non-destructive. Use manual scope only when automation cannot reasonably decide the result.",
              "Classify each acceptance test as verificationPhase release-gate or post-release. A release-gate check must be independently verifiable from the integrated candidate before publication. Anything that observes the eventual assistant reply, a user notification, deployment, publication, or another effect that can only happen after final verification is post-release. Never make a release-gate check depend on a post-release effect.",
              "Post-release checks are recorded as deferred obligations but are never sent to the release verifier and never block publication.",
              "Return this exact JSON shape with no additional fields:",
              '{"acceptanceTests":[{"id":"stable-id","title":"observable behavior","criterionIds":["exact confirmed criterion ID"],"category":"functional|architectural|scope|runtime|regression|manual","scope":"protected|global|manual","verificationPhase":"release-gate|post-release","procedure":"specific independent verification steps","expectedOutcome":"precise pass condition"}]}',
            ].join("\n").slice(0, 150_000),
          },
          taskAcceptanceTestBatchSchema,
        ),
      ),
    );
    const rawAcceptanceTests: z.input<typeof plannedAcceptanceTestSchema>[] = batchResults.flatMap(
      (batchResult) => batchResult.value.acceptanceTests,
    );
    const acceptanceTests = comprehensiveAcceptanceTests(rawAcceptanceTests, input.contract);
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
      executionId: null,
      type: "acceptance-plan-created",
      actorRole: "planner",
      modelId: taskPlanResult.actualModelId,
      summary: "Planner created the protected acceptance-test plan",
      metadata: {
        testCount: acceptanceTests.length,
        coveredCriteria: new Set(acceptanceTests.flatMap((test) => test.criterionIds)).size,
        contractVersion: input.contract.version,
        acceptanceTestBatches: taskBatches.length,
      },
    });
    const route = selectRoute({
      requestedMode: input.orchestration.requestedMode,
      taskCount: plannedTasks.length,
      changedAreaCount: new Set(plannedTasks.flatMap((task) => task.allowedPaths.map((entry) => entry.split("/")[0]))).size,
      hasOverlappingWriteScopes: tasksHaveOverlappingWriteScopes(plannedTasks),
      coupling: taskPlanResult.value.coupling,
      estimatedCalls: taskPlanResult.value.estimatedCalls,
      estimatedContextTokens: taskPlanResult.value.estimatedContextTokens,
      budget: input.orchestration.budget,
    });
    const ids = plannedTasks.map(() => this.newId());
    const criterionIds = new Set(input.contract.criteria.map((criterion) => criterion.id));
    let tasks: OrchestrationTask[] = plannedTasks.map((task, index) => {
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
      const combinedObjective = tasks
        .map((task) => task.objective.trim())
        .filter((objective, index, values) => values.indexOf(objective) === index)
        .join("; ")
        .slice(0, 6_000);
      tasks = [{
        id: this.newId(),
        orchestrationId: input.orchestration.id,
        title: route.selectedMode === "direct" ? "Direct confirmed execution" : "Focused combined worker",
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
      executionId: taskPlanResult.executionId,
      type: "route-decision",
      actorRole: "planner",
      modelId: taskPlanResult.actualModelId,
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
                deterministicPreflight: input.plan.selectedMode === "one-worker",
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
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: null,
        type: "verification-step",
        actorRole: "control-plane",
        modelId: null,
        summary: "Started protected and global verification",
        metadata: {},
      });
      let verification = await this.verification.run(
        input.orchestration.id,
        null,
        candidate.path,
        ["protected", "global", "manual"],
        sink,
        signal,
      );
      let plannedVerification = await this.runPlannedAcceptanceVerification(
        input,
        roles,
        candidate.path,
        sink,
        signal,
      );
      if (!requiredVerificationPassed([...verification, ...plannedVerification])) {
        const failing = [...verification, ...plannedVerification].filter(
          (record) => record.status === "failed",
        );
        const repaired = await this.attemptCandidateRepair(
          input,
          roles,
          candidate,
          failing,
          signal,
        ).catch(() => false);
        if (repaired) {
          verification = await this.verification.run(
            input.orchestration.id,
            null,
            candidate.path,
            ["protected", "global", "manual"],
            sink,
            signal,
          );
          plannedVerification = await this.runPlannedAcceptanceVerification(
            input,
            roles,
            candidate.path,
            sink,
            signal,
          );
        }
      }
      if (!requiredVerificationPassed([...verification, ...plannedVerification])) {
        const archived = await this.integrator
          .archive(candidate, this.options.archiveRoot)
          .catch(async (archiveError: unknown) => {
            await logError(
              "driver",
              `orchestration ${input.orchestration.id}: failed candidate could not be archived: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`,
            );
            return null;
          });
        await this.cleanup(results, "archive");
        await this.workspaces.cleanupOrchestration(input.orchestration.id, "clean");
        await sink.recordEvent({
          orchestrationId: input.orchestration.id,
          taskId: null,
          executionId: null,
          type: "candidate-archived",
          actorRole: "control-plane",
          modelId: null,
          summary: archived
            ? "The failed integration candidate was archived for inspection"
            : "The failed integration candidate could not be archived",
          metadata: { archived: Boolean(archived) },
        });
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
      await logError(
        "driver",
        `orchestration ${input.orchestration.id} execution failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
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
      this.options.modelCallTimeoutMs,
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

  private async attemptCandidateRepair(
    input: ExecuteInput,
    roles: RoleExecutor,
    candidate: IntegrationCandidate,
    failing: VerificationRecord[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!failing.length) return false;
    await logError(
      "driver",
      `orchestration ${input.orchestration.id}: candidate failed ${failing.length} verification(s), attempting one repair pass`,
    );
    try {
      await roles.text({
        orchestrationId: input.orchestration.id,
        agentId: input.orchestration.agentId,
        taskId: null,
        role: "worker",
        workspacePath: candidate.path,
        sandboxMode: "workspace-write",
        signal,
        prompt: [
          "The integrated candidate in this workspace failed the following acceptance checks.",
          "Edit only what is necessary to fix every check below without breaking anything that currently passes.",
          ...failing.map((record) => `- ${record.commandOrCheck}: ${record.outputSummary}`),
        ].join("\n"),
      });
      // The repair pass can add or touch files beyond the original task diff
      // (e.g. a new CSS file). Recompute changes against the original base so
      // publish() later copies everything the repair actually did, not just
      // the pre-repair change set.
      const refreshedManifest = await workspaceManifest(candidate.path);
      candidate.manifest = refreshedManifest;
      candidate.changes = diffManifest(candidate.base, refreshedManifest);
      return true;
    } catch (error) {
      await logError(
        "driver",
        `orchestration ${input.orchestration.id}: repair pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
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

  private async verifyAcceptanceTestBatch(
    input: ExecuteInput,
    roles: RoleExecutor,
    candidateWorkspacePath: string,
    batch: PlannedAcceptanceTest[],
    signal: AbortSignal,
  ): Promise<Map<string, VerificationResultEntry>> {
    const result = await roles.structured(
      {
        orchestrationId: input.orchestration.id,
        agentId: input.orchestration.agentId,
        taskId: null,
        role: "verifier",
        workspacePath: candidateWorkspacePath,
        sandboxMode: "read-only",
        signal,
        prompt: [
          "Independently verify the integrated candidate. Do not edit any files.",
          "Inspect the actual workspace and run relevant non-destructive tests, type checks, builds, or static checks where available.",
          `You MUST return exactly ${batch.length} results, one per testId listed below. Do not summarize or group tests — every testId needs its own entry. Any testId you omit is automatically treated as a failed test, so when in doubt include it with your best evidence rather than leaving it out.`,
          "Passing requires concrete evidence; uncertainty or an unverified claim must fail.",
          `Required testIds (count=${batch.length}): ${JSON.stringify(batch.map((test) => test.id))}`,
          `Confirmed contract: ${JSON.stringify({ version: input.contract.version, goal: input.contract.intent.goal, criteria: input.contract.criteria })}`,
          `Protected planner-generated acceptance tests: ${JSON.stringify(batch)}`,
        ].join("\n").slice(0, 150_000),
      },
      acceptanceVerificationSchema,
    );
    const returned = new Map(result.value.results.map((entry) => [entry.testId, entry]));
    const missingIds = batch.map((test) => test.id).filter((id) => !returned.has(id));
    if (missingIds.length) {
      await logError(
        "driver",
        `orchestration ${input.orchestration.id}: verifier omitted ${missingIds.length}/${batch.length} required tests in a batch; requesting the missing ones`,
      );
      const completion = await roles.structured(
        {
          orchestrationId: input.orchestration.id,
          agentId: input.orchestration.agentId,
          taskId: null,
          role: "verifier",
          workspacePath: candidateWorkspacePath,
          sandboxMode: "read-only",
          signal,
          prompt: [
            "Your previous verification response omitted required acceptance tests. Do not re-verify tests you already reported.",
            `Return exactly one result for each of these ${missingIds.length} testIds only: ${JSON.stringify(missingIds)}`,
            `Protected planner-generated acceptance tests (full detail, filter to the ids above): ${JSON.stringify(batch.filter((test) => missingIds.includes(test.id)))}`,
          ].join("\n").slice(0, 150_000),
        },
        acceptanceVerificationSchema,
      ).catch(async (completionError: unknown) => {
        await logError(
          "driver",
          `orchestration ${input.orchestration.id}: follow-up call for ${missingIds.length} missing tests failed: ${completionError instanceof Error ? completionError.message : String(completionError)}`,
        );
        return null;
      });
      for (const entry of completion?.value.results ?? []) {
        if (missingIds.includes(entry.testId)) returned.set(entry.testId, entry);
      }
    }
    return returned;
  }

  private async runPlannedAcceptanceVerification(
    input: ExecuteInput,
    roles: RoleExecutor,
    candidateWorkspacePath: string,
    sink: OrchestrationSink,
    signal: AbortSignal,
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
    const startedAt = this.now().toISOString();
    const verificationBatches: PlannedAcceptanceTest[][] = [];
    for (let i = 0; i < automated.length; i += VERIFICATION_BATCH_SIZE) {
      verificationBatches.push(automated.slice(i, i + VERIFICATION_BATCH_SIZE));
    }
    const batchMaps = await Promise.all(
      verificationBatches.map((batch) =>
        this.verifyAcceptanceTestBatch(input, roles, candidateWorkspacePath, batch, signal),
      ),
    );
    const returned = new Map<string, VerificationResultEntry>();
    for (const batchMap of batchMaps) {
      for (const [testId, entry] of batchMap) returned.set(testId, entry);
    }
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
    await sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: null,
      executionId: null,
      type: "acceptance-verification-completed",
      actorRole: "verifier",
      modelId: this.options.models.verifier,
      summary: "Verifier evaluated the planner-generated acceptance tests",
      metadata: {
        testCount: records.length,
        verificationBatches: verificationBatches.length,
        passed: records.filter((record) => record.status === "passed").length,
        failed: records.filter((record) => record.status === "failed").length,
        skipped: records.filter((record) => record.status === "skipped").length,
        manual: records.filter((record) => record.scope === "manual").length,
        regressionNotApplicable: skippedRegressionIds.size,
        deferredPostRelease: postReleaseIds.size,
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
