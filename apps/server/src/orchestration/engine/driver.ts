import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentRunner } from "../../types.js";
import type {
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionContract,
  ExecutionOutcome,
  IntentDraft,
  ModelRole,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  PlanInput,
  PlanResult,
  SelectedExecutionMode,
  TokenUsage,
} from "../contracts.js";
import {
  buildApplicationMap,
  renderMapForModel,
  toApplicationMapSummary,
  type ApplicationMap,
} from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import {
  applyMergePlan,
  applyResolvedConflict,
  collectConflictContext,
  detectMainWorkspaceDrift,
  planDeterministicMerge,
  publishToMainWorkspace,
  type TaskChangeSet,
} from "./integrator.js";
import {
  RoleExecutor,
  addUsage,
  emptyUsage,
  runnerCapabilityProbe,
  type ModelCapabilityProbe,
  type ModelRoleConfig,
} from "./role-executor.js";
import { decideRoute, type RouteSignals } from "./router.js";
import {
  ProcessCommandExecutor,
  VerificationService,
  type CheckScope,
  type CommandExecutor,
  type TrustedCheckDefinition,
} from "./verification.js";
import {
  BudgetTracker,
  WorkerLoop,
  type PricingTable,
  type TaskOutcome,
} from "./worker-loop.js";
import {
  WorkerWorkspaceManager,
  hashDirectory,
  type CleanupPolicy,
  type WorkerWorkspace,
} from "./worker-workspaces.js";

/**
 * The real execution driver behind the control plane's port.
 *
 * It owns planner/worker/verifier/integrator model calls, adaptive routing,
 * versioned application maps, context allocation, worker isolation, preflight,
 * bounded loops, protected verification, artifacts, dependency drift,
 * escalation, deterministic-first integration, and verified publication.
 */

export class OrchestrationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationPlanError";
  }
}

export interface OrchestrationEngineOptions {
  /** The existing platform runner. Real Codex CLI + Ark in production. */
  runner: AgentRunner;
  /** Trusted root for per-orchestration worker snapshots. */
  tempRoot: string;
  /** Trusted root for archived worker snapshots. */
  archiveRoot: string;
  /** Trusted root for per-role Codex/Runtime state directories. */
  runtimeHomeRoot: string;
  /** Mode-0700 trusted storage for protected evaluator definitions. */
  protectedEvaluatorRoot: string;
  models: ModelRoleConfig;
  /**
   * Trusted, argv-only check definitions keyed by contract criterion ID.
   * Never accepts a browser-supplied command string.
   */
  checkCatalog?: Record<string, TrustedCheckDefinition> | undefined;
  pricing?: PricingTable | undefined;
  cleanupPolicy?: CleanupPolicy | undefined;
  /**
   * Pre-rendered Codex CLI `config.toml` content (see
   * `buildCodexConfigToml` in `config.ts`) written into every fresh,
   * isolated per-role `CODEX_HOME` this driver creates. Without this, a
   * freshly created runtime home has no config, so Codex CLI falls back to
   * its own OpenAI default and fails with a 401 against
   * `api.openai.com` -- unrelated to whether Ark credentials are actually
   * configured correctly. Optional so existing tests that construct this
   * driver without Ark-specific config keep working unchanged.
   */
  codexConfigToml?: string | undefined;
  commandExecutor?: CommandExecutor | undefined;
  modelCapabilityProbe?: ModelCapabilityProbe | undefined;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
}

const intentSchema = z.object({
  goal: z.string().min(1).max(2_000),
  requirements: z.array(z.string().min(1).max(600)).max(30).default([]),
  assumptions: z.array(z.string().min(1).max(600)).max(30).default([]),
  nonGoals: z.array(z.string().min(1).max(600)).max(30).default([]),
  architectureDecisions: z.array(z.string().min(1).max(600)).max(30).default([]),
  materialQuestions: z.array(z.string().min(1).max(600)).max(20).default([]),
  manualExpectations: z.array(z.string().min(1).max(600)).max(20).default([]),
  estimate: z
    .object({
      inputTokenLow: z.number().int().min(0).max(50_000_000),
      inputTokenHigh: z.number().int().min(0).max(50_000_000),
      outputTokenLow: z.number().int().min(0).max(50_000_000),
      outputTokenHigh: z.number().int().min(0).max(50_000_000),
      assumptions: z.array(z.string().min(1).max(400)).max(12).default([]),
    })
    .optional(),
});

const INTENT_SCHEMA_DESCRIPTION = [
  "{",
  '  "goal": "one sentence",',
  '  "requirements": ["..."],',
  '  "assumptions": ["..."],',
  '  "nonGoals": ["..."],',
  '  "architectureDecisions": ["..."],',
  '  "materialQuestions": ["..."],',
  '  "manualExpectations": ["..."],',
  '  "estimate": { "inputTokenLow": 0, "inputTokenHigh": 0, "outputTokenLow": 0, "outputTokenHigh": 0, "assumptions": ["..."] }',
  "}",
].join("\n");

const planSchema = z.object({
  decomposable: z.boolean(),
  reason: z.string().min(1).max(1_000),
  tasks: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        objective: z.string().min(1).max(2_000),
        dependsOn: z.array(z.string().min(1).max(80)).max(10).default([]),
        allowedPaths: z.array(z.string().min(1).max(300)).min(1).max(20),
        acceptanceCriterionIds: z.array(z.string().min(1).max(120)).max(20).default([]),
        requiredArtifacts: z.array(z.string().min(1).max(120)).max(10).default([]),
        expectedArtifacts: z.array(z.string().min(1).max(120)).max(10).default([]),
      }),
    )
    .min(1)
    .max(8),
});

const PLAN_SCHEMA_DESCRIPTION = [
  "{",
  '  "decomposable": true,',
  '  "reason": "why this decomposition",',
  '  "tasks": [{',
  '    "key": "persistence",',
  '    "title": "short title",',
  '    "objective": "what this worker must achieve",',
  '    "dependsOn": ["other-key"],',
  '    "allowedPaths": ["src/area/**"],',
  '    "acceptanceCriterionIds": ["FR-1"],',
  '    "requiredArtifacts": ["shared-name"],',
  '    "expectedArtifacts": ["shared-name"]',
  "  }]",
  "}",
].join("\n");

const verifierSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  summary: z.string().min(1).max(2_000),
  concerns: z.array(z.string().min(1).max(400)).max(10).default([]),
});

const VERIFIER_SCHEMA_DESCRIPTION = [
  "{",
  '  "verdict": "pass" | "fail",',
  '  "summary": "what the evidence shows",',
  '  "concerns": ["..."]',
  "}",
].join("\n");

const integratorSchema = z.object({
  resolutions: z
    .array(
      z.object({
        path: z.string().min(1).max(400),
        content: z.string().max(64_000),
        rationale: z.string().max(600).default(""),
      }),
    )
    .max(20),
  unresolved: z.array(z.string().min(1).max(400)).max(20).default([]),
});

const INTEGRATOR_SCHEMA_DESCRIPTION = [
  "{",
  '  "resolutions": [{ "path": "relative/path.ts", "content": "full merged file body", "rationale": "why" }],',
  '  "unresolved": ["relative/path.ts"]',
  "}",
].join("\n");

interface ActiveOrchestration {
  executionIds: Set<string>;
  cancelled: boolean;
}

export class OrchestrationEngineDriver implements OrchestrationExecutionDriver {
  private readonly active = new Map<string, ActiveOrchestration>();

  private readonly workspaces: WorkerWorkspaceManager;

  private readonly probe: ModelCapabilityProbe;

  private readonly commandExecutor: CommandExecutor;

  private readonly checkCatalog: Record<string, TrustedCheckDefinition>;

  constructor(private readonly options: OrchestrationEngineOptions) {
    this.workspaces = new WorkerWorkspaceManager(options.tempRoot, options.archiveRoot);
    this.probe = options.modelCapabilityProbe ?? runnerCapabilityProbe(options.runner);
    this.commandExecutor = options.commandExecutor ?? new ProcessCommandExecutor();
    this.checkCatalog = options.checkCatalog ?? {};
  }

  private get clock(): () => Date {
    return this.options.clock ?? (() => new Date());
  }

  private get idFactory(): () => string {
    return this.options.idFactory ?? randomUUID;
  }

  private pricingStatus(): "configured" | "unknown" {
    const pricing = this.options.pricing ?? {};
    const ids = new Set(
      [
        this.options.models.fallbackModelId,
        this.options.models.planner,
        this.options.models.worker,
        this.options.models.verifier,
        this.options.models.integrator,
      ].filter((value): value is string => Boolean(value)),
    );
    return [...ids].some((id) => pricing[id]) ? "configured" : "unknown";
  }

  private priceRange(
    modelId: string,
    inputLow: number,
    inputHigh: number,
    outputLow: number,
    outputHigh: number,
  ): { low: number | null; high: number | null } {
    const price = (this.options.pricing ?? {})[modelId];
    if (!price) return { low: null, high: null };
    const compute = (input: number, output: number) =>
      Number(
        (
          ((price.input ?? 0) * input + (price.output ?? 0) * output) /
          1_000_000
        ).toFixed(6),
      );
    return { low: compute(inputLow, outputLow), high: compute(inputHigh, outputHigh) };
  }

  private track(orchestrationId: string): ActiveOrchestration {
    const existing = this.active.get(orchestrationId);
    if (existing) return existing;
    const created: ActiveOrchestration = { executionIds: new Set(), cancelled: false };
    this.active.set(orchestrationId, created);
    return created;
  }

  private async runtimeHomes(
    orchestrationId: string,
  ): Promise<Partial<Record<ModelRole, string>>> {
    const roles: ModelRole[] = ["planner", "worker", "verifier", "integrator"];
    const homes: Partial<Record<ModelRole, string>> = {};
    for (const role of roles) {
      const directory = path.join(
        path.resolve(this.options.runtimeHomeRoot),
        sanitize(orchestrationId),
        role,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (this.options.codexConfigToml) {
        await writeFile(path.join(directory, "config.toml"), this.options.codexConfigToml, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      homes[role] = directory;
    }
    return homes;
  }

  private makeRoleExecutor(input: {
    orchestrationId: string;
    agentId: string;
    sink: OrchestrationSink;
    signal: AbortSignal;
    runtimeHomes?: Partial<Record<ModelRole, string>> | undefined;
  }): RoleExecutor {
    const tracked = this.track(input.orchestrationId);
    return new RoleExecutor({
      orchestrationId: input.orchestrationId,
      agentId: input.agentId,
      runner: this.options.runner,
      sink: input.sink,
      models: this.options.models,
      probe: this.probe,
      signal: input.signal,
      runtimeHomes: input.runtimeHomes,
      idFactory: this.idFactory,
      onExecutionStart: (executionId) => tracked.executionIds.add(executionId),
      onExecutionEnd: (executionId) => tracked.executionIds.delete(executionId),
    });
  }

  // ------------------------------------------------------------------
  // Intent elaboration
  // ------------------------------------------------------------------

  async elaborateIntent(
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<{ draft: IntentDraft; estimate: CostEstimate }> {
    const runtimeHomes = await this.runtimeHomes(input.orchestrationId);
    const executor = this.makeRoleExecutor({
      orchestrationId: input.orchestrationId,
      agentId: input.agentId,
      sink,
      signal,
      runtimeHomes,
    });
    const map = await buildApplicationMap(input.workspacePath, {
      protectedPaths: [this.options.protectedEvaluatorRoot],
      now: this.clock,
    });

    const result = await executor.callStructured(intentSchema, INTENT_SCHEMA_DESCRIPTION, {
      role: "planner",
      taskId: null,
      prompt: [
        "You are the global planner for a coding orchestration.",
        "Elaborate the user's intent. DO NOT write code and DO NOT edit any file.",
        "",
        renderMapForModel(map, 60),
        "",
        "User prompt:",
        input.prompt,
        "",
        "Reply with a single JSON object and nothing else:",
        INTENT_SCHEMA_DESCRIPTION,
      ].join("\n"),
      workspacePath: input.workspacePath,
      sandboxMode: "read-only",
      estimatedInputTokens: Math.min(20_000, map.fileCount * 40 + input.prompt.length / 4),
      estimatedOutputTokens: 900,
      summary: "Planner elaborated the user intent",
      metadata: { stage: "intent", applicationMapVersion: map.version },
    });

    if (result.kind !== "ok") {
      throw new OrchestrationPlanError(
        "Intent elaboration failed: " +
          ("reason" in result ? result.reason : result.kind === "error" ? result.error : result.error),
      );
    }

    const draft: IntentDraft = {
      id: this.idFactory(),
      orchestrationId: input.orchestrationId,
      revision: 1,
      goal: result.value.goal,
      requirements: result.value.requirements,
      assumptions: result.value.assumptions,
      nonGoals: result.value.nonGoals,
      architectureDecisions: result.value.architectureDecisions,
      materialQuestions: result.value.materialQuestions,
      manualExpectations: result.value.manualExpectations,
      createdAt: this.clock().toISOString(),
    };

    const modelled = result.value.estimate;
    const inputTokenLow = modelled?.inputTokenLow ?? Math.max(1_000, map.fileCount * 30);
    const inputTokenHigh = Math.max(
      inputTokenLow,
      modelled?.inputTokenHigh ?? inputTokenLow * 4,
    );
    const outputTokenLow = modelled?.outputTokenLow ?? 500;
    const outputTokenHigh = Math.max(
      outputTokenLow,
      modelled?.outputTokenHigh ?? outputTokenLow * 6,
    );
    const pricingStatus = this.pricingStatus();
    const usd = this.priceRange(
      result.modelId,
      inputTokenLow,
      inputTokenHigh,
      outputTokenLow,
      outputTokenHigh,
    );

    const estimate: CostEstimate = {
      inputTokenLow,
      inputTokenHigh,
      outputTokenLow,
      outputTokenHigh,
      estimatedUsdLow: pricingStatus === "configured" ? usd.low : null,
      estimatedUsdHigh: pricingStatus === "configured" ? usd.high : null,
      pricingStatus,
      assumptions: [
        ...(modelled?.assumptions ?? []),
        "Application map version " + map.version + " with " + map.fileCount + " files",
        pricingStatus === "unknown"
          ? "No model pricing is configured, so dollar estimates are unavailable"
          : "Estimates use configured per-million-token prices, not billed cost",
        result.modelFallback
          ? "All logical roles share the configured Ark model because no per-role override is available"
          : "Per-role model overrides are active",
      ],
    };

    await sink.recordEvent({
      orchestrationId: input.orchestrationId,
      taskId: null,
      executionId: null,
      type: "intent.drafted",
      actorRole: "planner",
      modelId: result.modelId,
      summary: "Intent draft prepared with " + draft.materialQuestions.length + " material question(s)",
      metadata: {
        requirements: draft.requirements.length,
        assumptions: draft.assumptions.length,
        materialQuestions: draft.materialQuestions.length,
        pricingStatus,
      },
    });

    return { draft, estimate };
  }

  // ------------------------------------------------------------------
  // Planning and adaptive routing
  // ------------------------------------------------------------------

  async plan(
    input: PlanInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<PlanResult> {
    const orchestrationId = input.orchestration.id;
    const runtimeHomes = await this.runtimeHomes(orchestrationId);
    const executor = this.makeRoleExecutor({
      orchestrationId,
      agentId: input.orchestration.agentId,
      sink,
      signal,
      runtimeHomes,
    });
    const map = await buildApplicationMap(input.workspacePath, {
      protectedPaths: [this.options.protectedEvaluatorRoot],
      now: this.clock,
    });
    const mapSummary = toApplicationMapSummary(map, orchestrationId);
    await sink.recordApplicationMap(mapSummary);

    const result = await executor.callStructured(planSchema, PLAN_SCHEMA_DESCRIPTION, {
      role: "planner",
      taskId: null,
      prompt: [
        "You are the global planner. A contract has been confirmed by the user.",
        "Produce a decomposition. DO NOT write code and DO NOT edit any file.",
        "",
        renderMapForModel(map, 80),
        "",
        "Confirmed contract v" + input.contract.version + ":",
        "Goal: " + input.contract.intent.goal,
        "Requirements:\n" +
          input.contract.intent.requirements.map((item) => "- " + item).join("\n"),
        "Acceptance criteria:\n" +
          input.contract.criteria
            .map(
              (criterion) =>
                "- " + criterion.id + " [" + criterion.kind + "] " + criterion.description,
            )
            .join("\n"),
        "",
        "Reply with a single JSON object and nothing else:",
        PLAN_SCHEMA_DESCRIPTION,
      ].join("\n"),
      workspacePath: input.workspacePath,
      sandboxMode: "read-only",
      estimatedInputTokens: Math.min(24_000, map.fileCount * 40 + 2_000),
      estimatedOutputTokens: 1_200,
      summary: "Planner produced a decomposition",
      metadata: { stage: "plan", applicationMapVersion: map.version },
    });

    if (result.kind !== "ok") {
      const reason = "reason" in result ? result.reason : result.error;
      await sink.recordEvent({
        orchestrationId,
        taskId: null,
        executionId: null,
        type: "plan.failed",
        actorRole: "planner",
        modelId: null,
        summary: "Planning failed",
        metadata: { reason: String(reason).slice(0, 300) },
      });
      throw new OrchestrationPlanError("Planning failed: " + reason);
    }

    const proposed = result.value.tasks;
    const allPaths = proposed.flatMap((task) => task.allowedPaths);
    const overlapping = allPaths.filter(
      (candidate, index) => allPaths.indexOf(candidate) !== index,
    );
    // Modularity signal: the concrete directory prefix of each allowed path,
    // ignoring glob segments, so "src/api/**" and "src/web/**" count as two
    // separate areas rather than one shared "src" root.
    const areas = new Set(
      allPaths.map(
        (candidate) =>
          candidate
            .split("/")
            .filter((segment) => segment.length > 0 && !segment.includes("*"))
            .join("/") || candidate,
      ),
    );
    const signals: RouteSignals = {
      requestedMode: input.orchestration.requestedMode,
      proposedTaskCount: proposed.length,
      distinctAreas: areas.size,
      overlappingPathCount: overlapping.length,
      totalPathCount: allPaths.length,
      contextFileCount: Math.min(map.fileCount, allPaths.length * 4),
      mapFileCount: map.fileCount,
      decomposable: result.value.decomposable && proposed.length > 1,
      budget: input.orchestration.budget,
    };
    const route = decideRoute(signals);

    await sink.recordEvent({
      orchestrationId,
      taskId: null,
      executionId: null,
      type: route.ok ? "plan.route-selected" : "plan.route-rejected",
      actorRole: "planner",
      modelId: result.modelId,
      summary: route.ok
        ? "Route " + route.mode + ": " + route.reason
        : "No viable route: " + route.reason,
      metadata: {
        requestedMode: input.orchestration.requestedMode,
        proposedTasks: proposed.length,
        couplingRatio: route.scores.couplingRatio,
        breadthScore: route.scores.breadthScore,
        maxModelCalls: input.orchestration.budget.maxModelCalls,
      },
    });

    if (!route.ok) {
      throw new OrchestrationPlanError(route.reason);
    }

    const tasks = this.materializeTasks(
      orchestrationId,
      route.mode,
      proposed,
      map.version,
      input.contract,
    );
    for (const task of tasks) {
      await sink.upsertTask(task);
    }

    return {
      selectedMode: route.mode,
      routeReason: route.reason,
      tasks,
      applicationMap: mapSummary,
    };
  }

  private materializeTasks(
    orchestrationId: string,
    mode: SelectedExecutionMode,
    proposed: z.infer<typeof planSchema>["tasks"],
    applicationMapVersion: number,
    contract: ExecutionContract,
  ): OrchestrationTask[] {
    const criterionIds = new Set(contract.criteria.map((criterion) => criterion.id));
    const keyToId = new Map<string, string>();
    for (const task of proposed) {
      keyToId.set(task.key, orchestrationId + ":" + sanitize(task.key));
    }

    if (mode === "direct" || mode === "one-worker") {
      const merged: OrchestrationTask = {
        id: orchestrationId + ":" + (mode === "direct" ? "direct" : "single"),
        orchestrationId,
        title:
          mode === "direct"
            ? "Direct execution of the confirmed contract"
            : "Single focused worker for the confirmed contract",
        objective: proposed.map((task) => task.objective).join(" "),
        status: "ready",
        dependsOn: [],
        allowedPaths: [...new Set(proposed.flatMap((task) => task.allowedPaths))],
        acceptanceCriterionIds: [
          ...new Set(
            proposed
              .flatMap((task) => task.acceptanceCriterionIds)
              .filter((id) => criterionIds.has(id)),
          ),
        ],
        requiredArtifactIds: [],
        observedArtifactVersions: {},
        applicationMapVersion,
        attemptCount: 0,
      };
      return [merged];
    }

    return proposed.map((task) => {
      const dependsOn = task.dependsOn
        .map((key) => keyToId.get(key))
        .filter((value): value is string => Boolean(value));
      return {
        id: keyToId.get(task.key) as string,
        orchestrationId,
        title: task.title,
        objective: task.objective,
        status: dependsOn.length > 0 ? "blocked" : "ready",
        dependsOn,
        allowedPaths: task.allowedPaths,
        acceptanceCriterionIds: task.acceptanceCriterionIds.filter((id) =>
          criterionIds.has(id),
        ),
        requiredArtifactIds: task.requiredArtifacts,
        observedArtifactVersions: {},
        applicationMapVersion,
        attemptCount: 0,
      } satisfies OrchestrationTask;
    });
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------

  async execute(
    input: ExecuteInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const orchestrationId = input.orchestration.id;
    const tracked = this.track(orchestrationId);
    tracked.cancelled = false;
    const policy = input.orchestration.budget;
    const budget = new BudgetTracker(policy, this.options.pricing ?? {});
    const runtimeHomes = await this.runtimeHomes(orchestrationId);
    const executor = this.makeRoleExecutor({
      orchestrationId,
      agentId: input.orchestration.agentId,
      sink,
      signal,
      runtimeHomes,
    });
    const verification = new VerificationService({
      orchestrationId,
      protectedRoot: this.options.protectedEvaluatorRoot,
      executor: this.commandExecutor,
      sink,
      clock: this.clock,
      idFactory: this.idFactory,
    });
    const registry = new ArtifactRegistry({
      sink,
      clock: this.clock,
      idFactory: this.idFactory,
    });
    const broker = new ContextBroker({
      protectedPaths: [this.options.protectedEvaluatorRoot],
    });

    const protectedChecks = await verification.installProtectedChecks(
      input.contract,
      this.checkCatalog,
    );
    await verification.recordUncoveredCriteria(input.contract, this.checkCatalog);
    await sink.recordEvent({
      orchestrationId,
      taskId: null,
      executionId: null,
      type: "verification.protected-installed",
      actorRole: "control-plane",
      modelId: null,
      summary:
        protectedChecks.length +
        " protected check(s) installed in trusted storage outside worker authority",
      metadata: {
        protectedCheckCount: protectedChecks.length,
        isolatedFromWorkspace: verification.isProtectedStorageIsolatedFrom(
          input.workspacePath,
        ),
      },
    });

    const map = await buildApplicationMap(input.workspacePath, {
      protectedPaths: [this.options.protectedEvaluatorRoot],
      version: input.plan.applicationMap.version,
      now: this.clock,
    });
    // Captured before any worker runs, so user edits during execution are
    // detectable as workspace drift instead of being silently overwritten.
    const baseManifest = await hashDirectory(input.workspacePath);

    const createdWorkspaces: WorkerWorkspace[] = [];
    const cleanupTargets: Array<{ directory: string; taskId: string | null }> = [];
    let totalUsage: TokenUsage = emptyUsage();

    try {
      const changeSets: TaskChangeSet[] = [];

      if (input.plan.selectedMode === "direct") {
        const direct = await this.runDirect({
          input,
          sink,
          executor,
          budget,
          signal,
        });
        if (direct.outcome) return direct.outcome;
        totalUsage = addUsage(totalUsage, direct.usage);
        if (direct.changeSet) changeSets.push(direct.changeSet);
        if (direct.workspace) createdWorkspaces.push(direct.workspace);
      } else {
        const loop = new WorkerLoop({
          orchestrationId,
          contract: input.contract,
          map,
          roleExecutor: executor,
          sink,
          broker,
          workspaces: this.workspaces,
          registry,
          verification,
          checkCatalog: this.checkCatalog,
          budget,
          policy,
          signal,
          sourceWorkspacePath: input.workspacePath,
          clock: this.clock,
          idFactory: this.idFactory,
          runtimeHomes,
        });

        const tasks = input.plan.tasks.map((task) => ({ ...task }));
        const ordered = topologicalOrder(tasks);
        const outcomes = new Map<string, TaskOutcome>();

        for (const task of ordered) {
          const outcome = await loop.runTask(task);
          outcomes.set(task.id, outcome);
          totalUsage = addUsage(totalUsage, outcome.usage);
          if (outcome.kind === "passed") {
            createdWorkspaces.push(outcome.workspace);
            changeSets.push(outcome.changeSet);
            const refreshed = await this.refreshStaleDependents({
              orchestrationId,
              artifacts: outcome.artifacts,
              tasks,
              outcomes,
              registry,
              loop,
              sink,
              changeSets,
              createdWorkspaces,
            });
            totalUsage = addUsage(totalUsage, refreshed.usage);
            if (refreshed.outcome) return refreshed.outcome;
            continue;
          }
          if (outcome.kind === "budget-exhausted") {
            await this.recordNoPublish(sink, orchestrationId, outcome.reason);
            return { kind: "budget-exhausted", reason: outcome.reason };
          }
          if (outcome.kind === "cancelled") {
            await this.recordNoPublish(sink, orchestrationId, outcome.reason);
            return { kind: "cancelled", reason: outcome.reason };
          }
          if (outcome.workspace) createdWorkspaces.push(outcome.workspace);
          await this.recordNoPublish(
            sink,
            orchestrationId,
            "Task " + task.id + " failed: " + outcome.diagnosis.reason,
          );
          if (outcome.diagnosis.action === "material-amendment") {
            return {
              kind: "needs-user",
              amendment: this.buildAmendment(
                input.contract,
                outcome.diagnosis.reason,
                "Execution found a material issue that must not be resolved by weakening the contract: " +
                  outcome.packet.lastError,
              ),
            };
          }
          return {
            kind: "failed",
            reason:
              "Task " +
              task.title +
              " failed after " +
              task.attemptCount +
              " bounded attempt(s) [" +
              outcome.diagnosis.classification +
              "]: " +
              outcome.diagnosis.reason,
          };
        }
      }

      if (signal.aborted || tracked.cancelled) {
        return { kind: "cancelled", reason: "Orchestration was cancelled before integration" };
      }

      // ---- deterministic-first integration ------------------------------
      const merge = planDeterministicMerge(changeSets);
      await sink.recordEvent({
        orchestrationId,
        taskId: null,
        executionId: null,
        type: "integration.deterministic",
        actorRole: "control-plane",
        modelId: null,
        summary:
          merge.operations.length +
          " change(s) reconciled deterministically, " +
          merge.conflicts.length +
          " conflict(s) remain",
        metadata: {
          operations: merge.operations.length,
          conflicts: merge.conflicts.length,
          conflictPaths: merge.conflicts.map((item) => item.path).join(",") || null,
        },
      });

      const staging = await this.workspaces.createStagingWorkspace({
        orchestrationId,
        sourcePath: input.workspacePath,
        label: "staging",
      });
      cleanupTargets.push({ directory: staging.directory, taskId: null });
      const applied = await applyMergePlan(merge, changeSets, staging.directory);

      if (merge.conflicts.length > 0) {
        const conflictResult = await this.resolveConflicts({
          conflicts: merge.conflicts,
          changeSets,
          stagingDirectory: staging.directory,
          executor,
          budget,
          sink,
          orchestrationId,
          contract: input.contract,
        });
        totalUsage = addUsage(totalUsage, conflictResult.usage);
        if (conflictResult.outcome) return conflictResult.outcome;
        applied.applied.push(...conflictResult.resolvedPaths);
      }

      // ---- protected and global verification on the combined candidate ---
      const globalCheckList = [
        ...protectedChecks,
        ...Object.values(this.checkCatalog).filter((check) => check.scope === "global"),
      ];
      const globalVerification = await verification.runChecks({
        checks: globalCheckList,
        workspacePath: staging.directory,
        taskId: null,
      });
      await verification.recordManualCriteria(input.contract.criteria, null);

      const verifierReview = await this.runVerifierReview({
        executor,
        budget,
        sink,
        orchestrationId,
        staging: staging.directory,
        checks: globalVerification,
        contract: input.contract,
      });
      totalUsage = addUsage(totalUsage, verifierReview.usage);

      if (!globalVerification.passed) {
        await this.recordNoPublish(
          sink,
          orchestrationId,
          "Global verification failed: " + globalVerification.failing.join(", "),
        );
        return {
          kind: "failed",
          reason:
            "Global verification failed (" +
            globalVerification.failing.join(", ") +
            "). The Agent workspace was left unchanged.",
        };
      }

      // ---- publish only after a global pass ------------------------------
      const publishPaths = [...new Set(applied.applied)];
      const drift = await detectMainWorkspaceDrift(
        input.workspacePath,
        baseManifest,
        publishPaths,
      );
      if (drift.drifted) {
        await sink.recordEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "integration.workspace-drift",
          actorRole: "control-plane",
          modelId: null,
          summary:
            "The Agent workspace changed under " +
            drift.conflictingPaths.length +
            " path(s) this orchestration would publish; nothing was overwritten",
          metadata: { paths: drift.conflictingPaths.slice(0, 10).join(",") },
        });
        return {
          kind: "needs-user",
          amendment: this.buildAmendment(
            input.contract,
            "The Agent workspace changed while this orchestration was running",
            "These files changed outside the orchestration and would be overwritten: " +
              drift.conflictingPaths.slice(0, 10).join(", "),
          ),
        };
      }

      const publishResult = await publishToMainWorkspace({
        stagingDirectory: staging.directory,
        mainWorkspacePath: input.workspacePath,
        paths: publishPaths.filter(
          (candidate) =>
            !merge.operations.some(
              (operation) => operation.path === candidate && operation.operation === "delete",
            ),
        ),
        removedPaths: merge.operations
          .filter((operation) => operation.operation === "delete")
          .map((operation) => operation.path),
      });
      if (publishResult.error) {
        await this.recordNoPublish(sink, orchestrationId, publishResult.error);
        return {
          kind: "failed",
          reason: "Publication failed and was rolled back: " + publishResult.error,
        };
      }

      const refreshedMap = await buildApplicationMap(input.workspacePath, {
        protectedPaths: [this.options.protectedEvaluatorRoot],
        previous: map,
        now: this.clock,
      });
      await sink.recordApplicationMap(
        toApplicationMapSummary(refreshedMap, orchestrationId),
      );
      await sink.recordEvent({
        orchestrationId,
        taskId: null,
        executionId: null,
        type: "publication.completed",
        actorRole: "control-plane",
        modelId: null,
        summary:
          "Published " +
          publishResult.published.length +
          " file(s) after global verification passed",
        metadata: {
          published: publishResult.published.slice(0, 20).join(",") || null,
          removed: publishResult.removed.slice(0, 20).join(",") || null,
          applicationMapVersion: refreshedMap.version,
          verifierVerdict: verifierReview.verdict,
        },
      });

      return {
        kind: "completed",
        finalOutput: [
          "Published " + publishResult.published.length + " file(s) to the Agent workspace.",
          "Route: " + input.plan.selectedMode + " - " + input.plan.routeReason,
          "Global checks passed: " +
            globalVerification.records.map((record) => record.commandOrCheck).join(", "),
          verifierReview.summary ? "Verifier: " + verifierReview.summary : "",
          "Tokens: " +
            totalUsage.inputTokens +
            " in / " +
            totalUsage.outputTokens +
            " out across " +
            budget.snapshot().modelCalls +
            " model call(s).",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    } finally {
      await this.cleanupWorkspaces(
        [
          ...createdWorkspaces.map((workspace) => ({
            directory: workspace.directory,
            taskId: workspace.taskId,
          })),
          ...cleanupTargets,
        ],
        sink,
        orchestrationId,
      );
      this.active.delete(orchestrationId);
    }
  }

  // ------------------------------------------------------------------
  // Direct execution (a real baseline, not a shortcut)
  // ------------------------------------------------------------------

  private async runDirect(params: {
    input: ExecuteInput;
    sink: OrchestrationSink;
    executor: RoleExecutor;
    budget: BudgetTracker;
    signal: AbortSignal;
  }): Promise<{
    outcome: ExecutionOutcome | null;
    usage: TokenUsage;
    changeSet: TaskChangeSet | null;
    workspace: WorkerWorkspace | null;
  }> {
    const { input, sink, executor, budget } = params;
    const orchestrationId = input.orchestration.id;
    const task = input.plan.tasks[0];
    const guard = budget.check();
    if (!guard.ok) {
      return {
        outcome: { kind: "budget-exhausted", reason: guard.reason },
        usage: emptyUsage(),
        changeSet: null,
        workspace: null,
      };
    }

    const workspace = await this.workspaces.createTaskWorkspace({
      orchestrationId,
      taskId: task?.id ?? orchestrationId + ":direct",
      executionId: this.idFactory(),
      sourcePath: input.workspacePath,
      allowedPaths: task?.allowedPaths ?? [],
    });

    const result = await executor.callText({
      role: "planner",
      taskId: task?.id ?? null,
      prompt: [
        "You are executing a confirmed contract directly in this workspace.",
        "",
        "Goal: " + input.contract.intent.goal,
        "Requirements:\n" +
          input.contract.intent.requirements.map((item) => "- " + item).join("\n"),
        "Acceptance criteria:\n" +
          input.contract.criteria
            .map((criterion) => "- " + criterion.id + ": " + criterion.description)
            .join("\n"),
        "",
        "Make the changes and summarise what you did.",
      ].join("\n"),
      workspacePath: workspace.directory,
      sandboxMode: "workspace-write",
      estimatedInputTokens: 4_000,
      estimatedOutputTokens: 1_500,
      summary: "Direct execution of the confirmed contract",
      metadata: { stage: "direct" },
    });
    budget.recordCall("role-direct", result.usage ?? emptyUsage(), result.modelCalls ?? 0);
    budget.recordStep();

    if (result.kind === "budget-denied") {
      return {
        outcome: { kind: "budget-exhausted", reason: result.reason },
        usage: result.usage,
        changeSet: null,
        workspace,
      };
    }
    if (result.kind === "cancelled") {
      return {
        outcome: { kind: "cancelled", reason: result.reason },
        usage: result.usage,
        changeSet: null,
        workspace,
      };
    }
    if (result.kind !== "ok") {
      const reason = "error" in result ? result.error : "Direct execution failed";
      return {
        outcome: { kind: "failed", reason: "Direct execution failed: " + reason },
        usage: result.usage,
        changeSet: null,
        workspace,
      };
    }

    const changes = await this.workspaces.inspectChanges(workspace);
    if (task) {
      task.status = "passed";
      task.attemptCount = 1;
      await sink.upsertTask({ ...task });
    }
    await sink.recordAttempt({
      id: this.idFactory(),
      orchestrationId,
      taskId: task?.id ?? orchestrationId + ":direct",
      number: 1,
      executionId: result.executionId,
      modelId: result.modelId,
      contextFileHashes: [],
      changedFiles: [...changes.changed, ...changes.added].slice(0, 40),
      status: "passed",
      usage: result.usage,
      errorSummary: null,
      createdAt: this.clock().toISOString(),
      completedAt: this.clock().toISOString(),
    });

    return {
      outcome: null,
      usage: result.usage,
      changeSet: {
        taskId: task?.id ?? orchestrationId + ":direct",
        workspaceDirectory: workspace.directory,
        baseManifest: workspace.baseManifest,
        manifest: changes.manifest,
        changed: changes.changed,
        added: changes.added,
        removed: changes.removed,
      },
      workspace,
    };
  }

  // ------------------------------------------------------------------
  // Dependency drift and focused refresh
  // ------------------------------------------------------------------

  private async refreshStaleDependents(params: {
    orchestrationId: string;
    artifacts: Array<{ id: string; name: string; version: number; producerTaskId: string }>;
    tasks: OrchestrationTask[];
    outcomes: Map<string, TaskOutcome>;
    registry: ArtifactRegistry;
    loop: WorkerLoop;
    sink: OrchestrationSink;
    changeSets: TaskChangeSet[];
    createdWorkspaces: WorkerWorkspace[];
  }): Promise<{ outcome: ExecutionOutcome | null; usage: TokenUsage }> {
    let usage = emptyUsage();
    for (const artifact of params.artifacts) {
      const full = params.registry.latest(artifact.name);
      if (!full || full.version < 2) continue;
      const report = params.registry.detectDrift(full, params.tasks);
      await params.registry.recordDrift(params.orchestrationId, report);
      for (const staleTaskId of report.staleTaskIds) {
        const previous = params.outcomes.get(staleTaskId);
        if (!previous || previous.kind !== "passed") continue;
        const task = params.tasks.find((item) => item.id === staleTaskId);
        if (!task) continue;

        task.status = "stale";
        task.attemptCount = 0;
        task.observedArtifactVersions = {
          ...task.observedArtifactVersions,
          [full.name]: full.version,
        };
        await params.sink.upsertTask({ ...task });
        await params.sink.recordEvent({
          orchestrationId: params.orchestrationId,
          taskId: task.id,
          executionId: null,
          type: "task.stale-refresh",
          actorRole: "control-plane",
          modelId: null,
          summary:
            "Refreshing " +
            task.title +
            " against " +
            full.name +
            " v" +
            full.version,
          metadata: { artifact: full.name, version: full.version },
        });

        const index = params.changeSets.findIndex((item) => item.taskId === task.id);
        if (index >= 0) params.changeSets.splice(index, 1);

        const outcome = await params.loop.runTask(task);
        params.outcomes.set(task.id, outcome);
        usage = addUsage(usage, outcome.usage);
        if (outcome.kind === "passed") {
          params.changeSets.push(outcome.changeSet);
          params.createdWorkspaces.push(outcome.workspace);
          continue;
        }
        if (outcome.kind === "budget-exhausted") {
          return { outcome: { kind: "budget-exhausted", reason: outcome.reason }, usage };
        }
        if (outcome.kind === "cancelled") {
          return { outcome: { kind: "cancelled", reason: outcome.reason }, usage };
        }
        return {
          outcome: {
            kind: "failed",
            reason:
              "Refreshed task " +
              task.title +
              " failed: " +
              outcome.diagnosis.reason,
          },
          usage,
        };
      }
    }
    return { outcome: null, usage };
  }

  // ------------------------------------------------------------------
  // Focused conflict integration
  // ------------------------------------------------------------------

  private async resolveConflicts(params: {
    conflicts: Array<{ path: string; taskIds: string[] }>;
    changeSets: TaskChangeSet[];
    stagingDirectory: string;
    executor: RoleExecutor;
    budget: BudgetTracker;
    sink: OrchestrationSink;
    orchestrationId: string;
    contract: ExecutionContract;
  }): Promise<{ outcome: ExecutionOutcome | null; usage: TokenUsage; resolvedPaths: string[] }> {
    const guard = params.budget.check();
    if (!guard.ok) {
      return {
        outcome: { kind: "budget-exhausted", reason: guard.reason },
        usage: emptyUsage(),
        resolvedPaths: [],
      };
    }
    const context = await collectConflictContext(params.conflicts, params.changeSets);
    const result = await params.executor.callStructured(
      integratorSchema,
      INTEGRATOR_SCHEMA_DESCRIPTION,
      {
        role: "integrator",
        taskId: null,
        prompt: [
          "You are the integrator. Only the conflicting files below are in scope.",
          "You do not receive worker transcripts.",
          "",
          "Contract goal: " + params.contract.intent.goal,
          "",
          ...context.map((entry) =>
            [
              "## " + entry.path,
              ...entry.versions.map(
                (version) =>
                  "### version from " + version.taskId + "\n```\n" + version.content + "\n```",
              ),
            ].join("\n"),
          ),
          "",
          "Reply with a single JSON object and nothing else:",
          INTEGRATOR_SCHEMA_DESCRIPTION,
        ].join("\n"),
        workspacePath: params.stagingDirectory,
        sandboxMode: "read-only",
        estimatedInputTokens: 6_000,
        estimatedOutputTokens: 2_000,
        summary: "Integrator resolved " + params.conflicts.length + " conflicting file(s)",
        metadata: { conflicts: params.conflicts.length },
      },
    );
    params.budget.recordCall(
      "role-integrator",
      result.usage ?? emptyUsage(),
      result.modelCalls ?? 0,
    );
    params.budget.recordStep();

    if (result.kind === "budget-denied") {
      return {
        outcome: { kind: "budget-exhausted", reason: result.reason },
        usage: result.usage,
        resolvedPaths: [],
      };
    }
    if (result.kind === "cancelled") {
      return {
        outcome: { kind: "cancelled", reason: result.reason },
        usage: result.usage,
        resolvedPaths: [],
      };
    }
    if (result.kind !== "ok") {
      return {
        outcome: {
          kind: "failed",
          reason: "Integration could not resolve conflicting files",
        },
        usage: result.usage,
        resolvedPaths: [],
      };
    }

    const conflictPaths = new Set(params.conflicts.map((conflict) => conflict.path));
    const resolvedPaths: string[] = [];
    for (const resolution of result.value.resolutions) {
      if (!conflictPaths.has(resolution.path)) continue;
      const written = await applyResolvedConflict(
        params.stagingDirectory,
        resolution.path,
        resolution.content,
      );
      if (written) resolvedPaths.push(resolution.path);
    }
    const unresolved = [...conflictPaths].filter(
      (candidate) => !resolvedPaths.includes(candidate),
    );
    await params.sink.recordEvent({
      orchestrationId: params.orchestrationId,
      taskId: null,
      executionId: result.executionId,
      type: "integration.conflicts-resolved",
      actorRole: "integrator",
      modelId: result.modelId,
      summary:
        resolvedPaths.length +
        " conflict(s) resolved, " +
        unresolved.length +
        " unresolved",
      metadata: {
        resolved: resolvedPaths.join(",") || null,
        unresolved: unresolved.join(",") || null,
      },
    });
    if (unresolved.length > 0) {
      return {
        outcome: {
          kind: "failed",
          reason: "Integration left unresolved conflicts: " + unresolved.join(", "),
        },
        usage: result.usage,
        resolvedPaths,
      };
    }
    return { outcome: null, usage: result.usage, resolvedPaths };
  }

  // ------------------------------------------------------------------
  // Verifier role review (advisory - it cannot override a failing check)
  // ------------------------------------------------------------------

  private async runVerifierReview(params: {
    executor: RoleExecutor;
    budget: BudgetTracker;
    sink: OrchestrationSink;
    orchestrationId: string;
    staging: string;
    checks: { passed: boolean; failing: string[]; records: Array<{ commandOrCheck: string; status: string; scope: CheckScope }> };
    contract: ExecutionContract;
  }): Promise<{ usage: TokenUsage; verdict: string; summary: string }> {
    const guard = params.budget.check();
    if (!guard.ok) {
      return { usage: emptyUsage(), verdict: "skipped", summary: "" };
    }
    const result = await params.executor.callStructured(
      verifierSchema,
      VERIFIER_SCHEMA_DESCRIPTION,
      {
        role: "verifier",
        taskId: null,
        prompt: [
          "You are the independent verifier. You are read-only and you cannot change any check result.",
          "Summarise whether the integrated candidate satisfies the confirmed contract.",
          "",
          "Contract goal: " + params.contract.intent.goal,
          "Criteria:\n" +
            params.contract.criteria
              .map((criterion) => "- " + criterion.id + ": " + criterion.description)
              .join("\n"),
          "",
          "Trusted check results:",
          params.checks.records
            .map((record) => "- " + record.commandOrCheck + " [" + record.scope + "] " + record.status)
            .join("\n") || "- (none)",
          "",
          "Reply with a single JSON object and nothing else:",
          VERIFIER_SCHEMA_DESCRIPTION,
        ].join("\n"),
        workspacePath: params.staging,
        sandboxMode: "read-only",
        estimatedInputTokens: 2_500,
        estimatedOutputTokens: 700,
        summary: "Independent verifier reviewed the integrated candidate",
        metadata: { stage: "verify", trustedChecksPassed: params.checks.passed },
      },
    );
    params.budget.recordCall(
      "role-verifier",
      result.usage ?? emptyUsage(),
      result.modelCalls ?? 0,
    );
    params.budget.recordStep();
    if (result.kind !== "ok") {
      return { usage: result.usage, verdict: "unavailable", summary: "" };
    }
    // The trusted checks remain authoritative; this verdict is evidence only.
    await params.sink.recordEvent({
      orchestrationId: params.orchestrationId,
      taskId: null,
      executionId: result.executionId,
      type: "verification.verifier-review",
      actorRole: "verifier",
      modelId: result.modelId,
      summary: "Verifier verdict " + result.value.verdict + " (advisory)",
      metadata: {
        verdict: result.value.verdict,
        trustedChecksPassed: params.checks.passed,
        concerns: result.value.concerns.slice(0, 5).join(" | ") || null,
      },
    });
    return {
      usage: result.usage,
      verdict: result.value.verdict,
      summary: result.value.summary.slice(0, 400),
    };
  }

  // ------------------------------------------------------------------
  // Cancellation and cleanup
  // ------------------------------------------------------------------

  async cancel(orchestrationId: string): Promise<boolean> {
    const tracked = this.active.get(orchestrationId);
    if (!tracked) return false;
    tracked.cancelled = true;
    for (const executionId of [...tracked.executionIds]) {
      await this.options.runner.cancel(executionId).catch(() => false);
    }
    return true;
  }

  private async cleanupWorkspaces(
    workspaces: Array<{ directory: string; taskId: string | null }>,
    sink: OrchestrationSink,
    orchestrationId: string,
  ): Promise<void> {
    const policy = this.options.cleanupPolicy ?? "archive";
    const seen = new Set<string>();
    for (const workspace of workspaces) {
      if (seen.has(workspace.directory)) continue;
      seen.add(workspace.directory);
      const result = await this.workspaces.cleanup(workspace.directory, policy).catch(
        (error: unknown) => ({
          policy,
          result: "refused" as const,
          path: workspace.directory,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      await sink
        .recordEvent({
          orchestrationId,
          taskId: workspace.taskId,
          executionId: null,
          type: "worker.workspace-" + result.result,
          actorRole: "control-plane",
          modelId: null,
          summary:
            "Worker workspace " +
            result.result +
            (result.reason ? ": " + result.reason : ""),
          metadata: { policy, result: result.result },
        })
        .catch(() => undefined);
    }
  }

  private async recordNoPublish(
    sink: OrchestrationSink,
    orchestrationId: string,
    reason: string,
  ): Promise<void> {
    await sink.recordEvent({
      orchestrationId,
      taskId: null,
      executionId: null,
      type: "publication.skipped",
      actorRole: "control-plane",
      modelId: null,
      summary: "Nothing was published to the Agent workspace",
      metadata: { reason: reason.slice(0, 300) },
    });
  }

  private buildAmendment(
    contract: ExecutionContract,
    reason: string,
    detail: string,
  ): ContractAmendment {
    const timestamp = this.clock().toISOString();
    return {
      id: this.idFactory(),
      orchestrationId: contract.orchestrationId,
      baseContractId: contract.id,
      proposedIntent: {
        ...contract.intent,
        id: this.idFactory(),
        revision: contract.intent.revision + 1,
        materialQuestions: [...contract.intent.materialQuestions, detail].slice(0, 20),
        createdAt: timestamp,
      },
      proposedCriteria: null,
      reason: reason.slice(0, 600),
      material: true,
      status: "pending",
      createdAt: timestamp,
      decidedAt: null,
    };
  }
}

/** Dependency-respecting task order; cycles fall back to declaration order. */
export function topologicalOrder(tasks: OrchestrationTask[]): OrchestrationTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const ordered: OrchestrationTask[] = [];
  const visit = (task: OrchestrationTask, stack: Set<string>): void => {
    if (visited.has(task.id) || stack.has(task.id)) return;
    stack.add(task.id);
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency, stack);
    }
    stack.delete(task.id);
    if (!visited.has(task.id)) {
      visited.add(task.id);
      ordered.push(task);
    }
  };
  for (const task of tasks) visit(task, new Set());
  return ordered;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80) || "item";
}
