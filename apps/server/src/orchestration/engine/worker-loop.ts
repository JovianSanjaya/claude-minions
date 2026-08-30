import { z } from "zod";
import type {
  BudgetPolicy,
  ExecutionContract,
  FailurePacket,
  ModelRole,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  WorkerAttempt,
} from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker, estimateTokens, type ContextPacket } from "./context-broker.js";
import {
  buildFailurePacket,
  classifyFailure,
  type Diagnosis,
} from "./failure-packet.js";
import type { TaskChangeSet } from "./integrator.js";
import {
  PREFLIGHT_SCHEMA_DESCRIPTION,
  preflightReportSchema,
  reviewPreflight,
  summarizePreflight,
} from "./preflight.js";
import { addUsage, emptyUsage, type RoleExecutor } from "./role-executor.js";
import type { TrustedCheckDefinition, VerificationService } from "./verification.js";
import {
  WorkerWorkspaceManager,
  type WorkerWorkspace,
} from "./worker-workspaces.js";

/**
 * Bounded worker loop: preflight -> write -> visible checks -> inspect ->
 * bounded retry. Attempts, model calls, tokens, estimated dollars, context
 * expansions, wall-clock time and cancellation are all enforced here, and every
 * exit path releases workspace bookkeeping.
 */

export const workerReportSchema = z.object({
  status: z.enum(["complete", "blocked"]),
  summary: z.string().min(1).max(2_000),
  changedFiles: z.array(z.string().min(1).max(400)).max(50).default([]),
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        kind: z.enum(["api", "interface", "schema", "decision", "manifest", "test-result"]),
        payload: z.string().min(1).max(8_000),
      }),
    )
    .max(10)
    .default([]),
  checksRun: z.array(z.string().min(1).max(120)).max(20).default([]),
  diagnosis: z.string().max(1_000).default(""),
});

export type WorkerReport = z.infer<typeof workerReportSchema>;

export const WORKER_SCHEMA_DESCRIPTION = [
  "{",
  '  "status": "complete" | "blocked",',
  '  "summary": "what you changed",',
  '  "changedFiles": ["relative/path.ts"],',
  '  "artifacts": [{ "name": "shared-name", "kind": "interface", "payload": "typed content" }],',
  '  "checksRun": ["check-id"],',
  '  "diagnosis": "why it is still failing, if it is"',
  "}",
].join("\n");

/** USD per million tokens by model ID. */
export type PricingTable = Record<
  string,
  { input?: number | undefined; cachedInput?: number | undefined; output?: number | undefined }
>;

export interface BudgetSnapshot {
  modelCalls: number;
  steps: number;
  usage: TokenUsage;
  estimatedUsd: number | null;
  elapsedMs: number;
}

/**
 * Engine-local budget enforcement. The control plane's `reserveModelCall` stays
 * authoritative; this tracker stops the engine from starting work the policy
 * cannot afford, including wall-clock and step limits the sink cannot see.
 */
export class BudgetTracker {
  private modelCalls = 0;
  private steps = 0;
  private usage: TokenUsage = emptyUsage();
  private estimatedUsd = 0;
  private pricingKnown = false;
  private readonly expansionsByTask = new Map<string, number>();

  constructor(
    private readonly policy: BudgetPolicy,
    private readonly pricing: PricingTable = {},
    private readonly now: () => number = () => Date.now(),
    private readonly startedAt: number = Date.now(),
  ) {}

  recordCall(modelId: string, usage: TokenUsage, calls = 1): void {
    this.modelCalls += calls;
    this.usage = addUsage(this.usage, usage);
    const price = this.pricing[modelId];
    if (price) {
      this.pricingKnown = true;
      this.estimatedUsd +=
        ((price.input ?? 0) * usage.inputTokens +
          (price.cachedInput ?? price.input ?? 0) * usage.cachedInputTokens +
          (price.output ?? 0) * usage.outputTokens) /
        1_000_000;
    }
  }

  recordStep(count = 1): void {
    this.steps += count;
  }

  recordExpansion(taskId: string): void {
    this.expansionsByTask.set(taskId, (this.expansionsByTask.get(taskId) ?? 0) + 1);
  }

  expansions(taskId: string): number {
    return this.expansionsByTask.get(taskId) ?? 0;
  }

  snapshot(): BudgetSnapshot {
    return {
      modelCalls: this.modelCalls,
      steps: this.steps,
      usage: { ...this.usage },
      estimatedUsd: this.pricingKnown ? Number(this.estimatedUsd.toFixed(6)) : null,
      elapsedMs: this.now() - this.startedAt,
    };
  }

  /** Returns a denial reason when new work must not start. */
  check(): { ok: true } | { ok: false; reason: string } {
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.policy.maxWallClockMs) {
      return {
        ok: false,
        reason:
          "Wall-clock budget exhausted after " +
          elapsed +
          " ms (limit " +
          this.policy.maxWallClockMs +
          " ms)",
      };
    }
    if (this.modelCalls >= this.policy.maxModelCalls) {
      return {
        ok: false,
        reason:
          "Model-call budget exhausted (" +
          this.modelCalls +
          "/" +
          this.policy.maxModelCalls +
          ")",
      };
    }
    if (this.steps >= this.policy.maxSteps) {
      return {
        ok: false,
        reason: "Step budget exhausted (" + this.steps + "/" + this.policy.maxSteps + ")",
      };
    }
    if (
      this.policy.maxInputTokens !== null &&
      this.usage.inputTokens >= this.policy.maxInputTokens
    ) {
      return {
        ok: false,
        reason:
          "Input-token budget exhausted (" +
          this.usage.inputTokens +
          "/" +
          this.policy.maxInputTokens +
          ")",
      };
    }
    if (
      this.policy.maxOutputTokens !== null &&
      this.usage.outputTokens >= this.policy.maxOutputTokens
    ) {
      return {
        ok: false,
        reason:
          "Output-token budget exhausted (" +
          this.usage.outputTokens +
          "/" +
          this.policy.maxOutputTokens +
          ")",
      };
    }
    if (
      this.policy.maxEstimatedUsd !== null &&
      this.pricingKnown &&
      this.estimatedUsd >= this.policy.maxEstimatedUsd
    ) {
      return {
        ok: false,
        reason:
          "Estimated-cost budget exhausted ($" +
          this.estimatedUsd.toFixed(4) +
          " of $" +
          this.policy.maxEstimatedUsd +
          ")",
      };
    }
    return { ok: true };
  }
}

export interface WorkerLoopDeps {
  orchestrationId: string;
  contract: ExecutionContract;
  map: ApplicationMap;
  roleExecutor: RoleExecutor;
  sink: OrchestrationSink;
  broker: ContextBroker;
  workspaces: WorkerWorkspaceManager;
  registry: ArtifactRegistry;
  verification: VerificationService;
  checkCatalog: Record<string, TrustedCheckDefinition>;
  budget: BudgetTracker;
  policy: BudgetPolicy;
  signal: AbortSignal;
  sourceWorkspacePath: string;
  clock: () => Date;
  idFactory: () => string;
  /** Per-role trusted Runtime state directories. */
  runtimeHomes?: Partial<Record<ModelRole, string>> | undefined;
}

export type TaskOutcome =
  | {
      kind: "passed";
      task: OrchestrationTask;
      workspace: WorkerWorkspace;
      changeSet: TaskChangeSet;
      artifacts: SharedArtifact[];
      usage: TokenUsage;
      attempts: number;
    }
  | {
      kind: "failed";
      task: OrchestrationTask;
      workspace: WorkerWorkspace | null;
      packet: FailurePacket;
      diagnosis: Diagnosis;
      usage: TokenUsage;
    }
  | { kind: "budget-exhausted"; task: OrchestrationTask; reason: string; usage: TokenUsage }
  | { kind: "cancelled"; task: OrchestrationTask; reason: string; usage: TokenUsage };

export class WorkerLoop {
  constructor(private readonly deps: WorkerLoopDeps) {}

  /** Runs one task end to end inside its own isolated workspace snapshot. */
  async runTask(task: OrchestrationTask): Promise<TaskOutcome> {
    const deps = this.deps;
    let usage = emptyUsage();
    let structuredFailures = 0;
    let deniedExpansions = 0;
    let workspace: WorkerWorkspace | null = null;
    let lastError = "";
    let failingChecks: string[] = [];
    let lastDiagnosis = "";
    let scopeViolations: string[] = [];
    let noChangesProduced = false;
    let budgetDenied = false;
    const expandedPaths: string[] = [];
    const attemptAllowance = deps.policy.maxWorkerAttempts;

    const fail = async (): Promise<TaskOutcome> => {
      const packet = buildFailurePacket({
        taskId: task.id,
        contractVersion: deps.contract.version,
        attemptCount: task.attemptCount,
        lastError,
        failingChecks,
        changedFiles: workspace
          ? (await deps.workspaces.inspectChanges(workspace)).changed
          : [],
        relevantInterfaces: Object.keys(task.observedArtifactVersions),
        workerDiagnosis: lastDiagnosis,
        usage,
      });
      const diagnosis = classifyFailure(packet, {
        dependencyStale: task.status === "stale",
        deniedExpansions,
        budgetDenied,
        scopeViolations,
        attemptsAllowed: attemptAllowance,
        noChangesProduced,
        repeatedProtectedFailure: false,
        structuredOutputFailures: structuredFailures,
      });
      task.status = "failed";
      await deps.sink.upsertTask({ ...task });
      await deps.sink.recordEvent({
        orchestrationId: deps.orchestrationId,
        taskId: task.id,
        executionId: null,
        type: "task.escalated",
        actorRole: "planner",
        modelId: null,
        summary:
          "Task failed after " +
          task.attemptCount +
          " bounded attempt(s): " +
          diagnosis.classification,
        metadata: {
          classification: diagnosis.classification,
          action: diagnosis.action,
          reason: diagnosis.reason.slice(0, 300),
          failingChecks: packet.failingChecks.join(",") || null,
          attempts: task.attemptCount,
        },
      });
      return { kind: "failed", task, workspace, packet, diagnosis, usage };
    };

    // ---- preflight (read-only) -------------------------------------------
    task.status = "preflight";
    await deps.sink.upsertTask({ ...task });

    workspace = await deps.workspaces.createTaskWorkspace({
      orchestrationId: deps.orchestrationId,
      taskId: task.id,
      executionId: deps.idFactory(),
      sourcePath: deps.sourceWorkspacePath,
      allowedPaths: task.allowedPaths,
    });
    await deps.sink.recordEvent({
      orchestrationId: deps.orchestrationId,
      taskId: task.id,
      executionId: null,
      type: "worker.workspace-created",
      actorRole: "control-plane",
      modelId: null,
      summary: "Isolated worker workspace prepared for " + task.title,
      metadata: {
        baseHash: workspace.baseHash.slice(0, 16),
        allowedPaths: task.allowedPaths.join(",") || null,
      },
    });

    let packet: ContextPacket | null = null;
    let approved = false;
    let preflightSummary = "";
    const maxPreflightRounds = deps.policy.maxContextExpansionsPerTask + 1;

    for (let round = 0; round < maxPreflightRounds && !approved; round += 1) {
      const guard = deps.budget.check();
      if (!guard.ok) {
        return { kind: "budget-exhausted", task, reason: guard.reason, usage };
      }
      if (deps.signal.aborted) {
        return { kind: "cancelled", task, reason: "Cancelled before preflight", usage };
      }

      packet = await deps.broker.buildPacket({
        task,
        contract: deps.contract,
        map: deps.map,
        artifacts: deps.registry.all(),
        workspacePath: workspace.directory,
        expandedPaths,
      });
      await deps.sink.recordContextPacket(packet.summary);
      await deps.sink.recordEvent({
        orchestrationId: deps.orchestrationId,
        taskId: task.id,
        executionId: null,
        type: "context.packet",
        actorRole: "control-plane",
        modelId: null,
        summary:
          "Context packet: " +
          packet.summary.sourceFiles.length +
          " file(s), ~" +
          packet.summary.estimatedTokens +
          " tokens, map v" +
          packet.summary.applicationMapVersion,
        metadata: {
          files: packet.summary.sourceFiles.length,
          estimatedTokens: packet.summary.estimatedTokens,
          applicationMapVersion: packet.summary.applicationMapVersion,
          contractVersion: packet.summary.contractVersion,
          expansions: expandedPaths.length,
        },
      });

      const workerVisible = Object.values(deps.checkCatalog).filter(
        (check) => check.scope === "worker-visible",
      );
      const result = await deps.roleExecutor.callStructured(
        preflightReportSchema,
        PREFLIGHT_SCHEMA_DESCRIPTION,
        {
          role: "worker",
          taskId: task.id,
          prompt: buildPreflightPrompt(packet, task, workerVisible),
          workspacePath: workspace.directory,
          sandboxMode: "read-only",
          estimatedInputTokens: packet.summary.estimatedTokens,
          estimatedOutputTokens: 600,
          summary: "Read-only preflight for " + task.title,
          metadata: { stage: "preflight", round },
        },
      );
      deps.budget.recordCall(
        "role-worker",
        result.usage ?? emptyUsage(),
        result.modelCalls ?? 0,
      );
      deps.budget.recordStep();
      usage = addUsage(usage, result.usage ?? emptyUsage());

      if (result.kind === "budget-denied") {
        budgetDenied = true;
        return { kind: "budget-exhausted", task, reason: result.reason, usage };
      }
      if (result.kind === "cancelled") {
        return { kind: "cancelled", task, reason: result.reason, usage };
      }
      if (result.kind === "invalid-output") {
        structuredFailures += 1;
        lastError = "Preflight response was unusable: " + result.error;
        return fail();
      }
      if (result.kind === "error") {
        lastError = "Preflight execution failed: " + result.error;
        return fail();
      }

      const review = reviewPreflight({
        report: result.value,
        task,
        contract: deps.contract,
        knownArtifacts: deps.registry.names(),
        priorExpansions: deps.budget.expansions(task.id),
        maxExpansions: deps.policy.maxContextExpansionsPerTask,
        allowedCheckIds: workerVisible.map((check) => check.id),
      });
      preflightSummary = summarizePreflight(result.value);

      await deps.sink.recordEvent({
        orchestrationId: deps.orchestrationId,
        taskId: task.id,
        executionId: null,
        type: "preflight." + review.decision,
        actorRole: "planner",
        modelId: null,
        summary: "Preflight " + review.decision + ": " + review.reason.slice(0, 200),
        metadata: { plan: preflightSummary, round },
      });

      if (review.decision === "approved") {
        approved = true;
        break;
      }
      if (review.decision === "rejected") {
        lastError = review.reason;
        lastDiagnosis = preflightSummary;
        return fail();
      }

      for (const request of review.requests) {
        const decision = await deps.broker.evaluateExpansion({
          workspacePath: workspace.directory,
          requestedPath: request.path,
          reason: request.reason,
          priorExpansions: deps.budget.expansions(task.id),
          budget: deps.policy,
        });
        await deps.sink.recordEvent({
          orchestrationId: deps.orchestrationId,
          taskId: task.id,
          executionId: null,
          type: decision.allowed ? "context.expansion-granted" : "context.expansion-denied",
          actorRole: "control-plane",
          modelId: null,
          summary: decision.reason.slice(0, 200),
          metadata: {
            requestedPath: request.path.slice(0, 200),
            requestReason: request.reason.slice(0, 200),
          },
        });
        if (decision.allowed && decision.resolvedPath) {
          expandedPaths.push(decision.resolvedPath);
          deps.budget.recordExpansion(task.id);
        } else {
          deniedExpansions += 1;
        }
      }
      if (expandedPaths.length === 0) {
        lastError = "Preflight requested context that could not be granted";
        return fail();
      }
    }

    if (!approved || !packet) {
      lastError = "Preflight was never approved within the expansion budget";
      return fail();
    }

    // ---- bounded write / check / retry loop --------------------------------
    let feedback = "";
    while (task.attemptCount < attemptAllowance) {
      const guard = deps.budget.check();
      if (!guard.ok) {
        return { kind: "budget-exhausted", task, reason: guard.reason, usage };
      }
      if (deps.signal.aborted) {
        return { kind: "cancelled", task, reason: "Cancelled before a worker attempt", usage };
      }

      task.attemptCount += 1;
      task.status = "running";
      await deps.sink.upsertTask({ ...task });

      const attemptStartedAt = deps.clock().toISOString();
      const result = await deps.roleExecutor.callStructured(
        workerReportSchema,
        WORKER_SCHEMA_DESCRIPTION,
        {
          role: "worker",
          taskId: task.id,
          prompt: buildWorkerPrompt(packet, task, preflightSummary, feedback),
          workspacePath: workspace.directory,
          sandboxMode: "workspace-write",
          estimatedInputTokens: packet.summary.estimatedTokens,
          estimatedOutputTokens: 1_200,
          summary: "Worker attempt " + task.attemptCount + " for " + task.title,
          metadata: { stage: "write", attempt: task.attemptCount },
        },
      );
      deps.budget.recordCall(
        "role-worker",
        result.usage ?? emptyUsage(),
        result.modelCalls ?? 0,
      );
      deps.budget.recordStep();
      usage = addUsage(usage, result.usage ?? emptyUsage());

      if (result.kind === "budget-denied") {
        budgetDenied = true;
        return { kind: "budget-exhausted", task, reason: result.reason, usage };
      }
      if (result.kind === "cancelled") {
        return { kind: "cancelled", task, reason: result.reason, usage };
      }
      if (result.kind === "invalid-output" || result.kind === "error") {
        structuredFailures += result.kind === "invalid-output" ? 1 : 0;
        lastError =
          result.kind === "invalid-output"
            ? "Worker response was unusable: " + result.error
            : "Worker execution failed: " + result.error;
        feedback = lastError;
        await this.recordAttempt(task, workspace, {
          number: task.attemptCount,
          startedAt: attemptStartedAt,
          status: "failed",
          usage: result.usage ?? emptyUsage(),
          changedFiles: [],
          contextFileHashes: packet.summary.sourceFiles.map((file) => file.sha256),
          errorSummary: lastError,
          modelId: "unknown",
        });
        continue;
      }

      const changes = await deps.workspaces.inspectChanges(workspace);
      scopeViolations = changes.scopeViolations;
      noChangesProduced =
        changes.changed.length === 0 &&
        changes.added.length === 0 &&
        changes.removed.length === 0;

      if (scopeViolations.length > 0) {
        lastError =
          "Worker changed files outside its allowed paths: " +
          scopeViolations.slice(0, 5).join(", ");
        feedback = lastError;
        await deps.sink.recordEvent({
          orchestrationId: deps.orchestrationId,
          taskId: task.id,
          executionId: result.executionId,
          type: "task.scope-violation",
          actorRole: "control-plane",
          modelId: result.modelId,
          summary: lastError.slice(0, 200),
          metadata: { violations: scopeViolations.slice(0, 10).join(",") },
        });
        await this.recordAttempt(task, workspace, {
          number: task.attemptCount,
          startedAt: attemptStartedAt,
          status: "failed",
          usage: result.usage,
          changedFiles: [...changes.changed, ...changes.added],
          contextFileHashes: packet.summary.sourceFiles.map((file) => file.sha256),
          errorSummary: lastError,
          modelId: result.modelId,
        });
        continue;
      }

      task.status = "verifying";
      await deps.sink.upsertTask({ ...task });
      const visibleChecks = Object.values(deps.checkCatalog).filter(
        (check) => check.scope === "worker-visible",
      );
      const verification = await deps.verification.runChecks({
        checks: visibleChecks,
        workspacePath: workspace.directory,
        taskId: task.id,
      });
      failingChecks = verification.failing;
      lastDiagnosis = result.value.diagnosis || result.value.summary;

      await this.recordAttempt(task, workspace, {
        number: task.attemptCount,
        startedAt: attemptStartedAt,
        status: verification.passed && result.value.status === "complete" ? "passed" : "failed",
        usage: result.usage,
        changedFiles: [...changes.changed, ...changes.added],
        contextFileHashes: packet.summary.sourceFiles.map((file) => file.sha256),
        errorSummary: verification.passed ? null : "Failing checks: " + failingChecks.join(", "),
        modelId: result.modelId,
      });

      if (!verification.passed || result.value.status !== "complete") {
        lastError = verification.passed
          ? "Worker reported it was blocked: " + result.value.summary
          : "Worker-visible checks failed: " + failingChecks.join(", ");
        feedback =
          lastError +
          (noChangesProduced ? " (no files were changed by the previous attempt)" : "");
        continue;
      }

      // ---- success: publish declared artifacts ---------------------------
      const artifacts: SharedArtifact[] = [];
      for (const declared of result.value.artifacts) {
        artifacts.push(
          await deps.registry.publish({
            orchestrationId: deps.orchestrationId,
            producerTaskId: task.id,
            kind: declared.kind,
            name: declared.name,
            payload: declared.payload,
          }),
        );
      }
      task.status = "passed";
      task.observedArtifactVersions = {
        ...task.observedArtifactVersions,
        ...packet.summary.artifactVersions,
      };
      await deps.sink.upsertTask({ ...task });

      const changeSet: TaskChangeSet = {
        taskId: task.id,
        workspaceDirectory: workspace.directory,
        baseManifest: workspace.baseManifest,
        manifest: changes.manifest,
        changed: changes.changed,
        added: changes.added,
        removed: changes.removed,
      };
      return {
        kind: "passed",
        task,
        workspace,
        changeSet,
        artifacts,
        usage,
        attempts: task.attemptCount,
      };
    }

    lastError = lastError || "Task exhausted its attempt budget";
    return fail();
  }

  private async recordAttempt(
    task: OrchestrationTask,
    workspace: WorkerWorkspace,
    input: {
      number: number;
      startedAt: string;
      status: WorkerAttempt["status"];
      usage: TokenUsage;
      changedFiles: string[];
      contextFileHashes: string[];
      errorSummary: string | null;
      modelId: string;
    },
  ): Promise<void> {
    await this.deps.sink.recordAttempt({
      id: this.deps.idFactory(),
      orchestrationId: this.deps.orchestrationId,
      taskId: task.id,
      number: input.number,
      executionId: workspace.executionId,
      modelId: input.modelId,
      contextFileHashes: input.contextFileHashes.slice(0, 40),
      changedFiles: input.changedFiles.slice(0, 40),
      status: input.status,
      usage: input.usage,
      errorSummary: input.errorSummary ? input.errorSummary.slice(0, 600) : null,
      createdAt: input.startedAt,
      completedAt: this.deps.clock().toISOString(),
    });
  }
}

function buildPreflightPrompt(
  packet: ContextPacket,
  task: OrchestrationTask,
  visibleChecks: TrustedCheckDefinition[],
): string {
  return [
    "You are a focused coding worker running in READ-ONLY mode.",
    "Do not edit any file. Produce a preflight plan only.",
    "",
    packet.rendered,
    "",
    "Checks available to you: " +
      (visibleChecks.map((check) => check.id + " (" + check.description + ")").join(", ") ||
        "none"),
    "",
    "Reply with a single JSON object and nothing else:",
    PREFLIGHT_SCHEMA_DESCRIPTION,
    "",
    "Only list files inside these allowed paths: " + task.allowedPaths.join(", "),
    "If you truly cannot proceed without another file, list it in missingContext with a concrete reason.",
  ].join("\n");
}

function buildWorkerPrompt(
  packet: ContextPacket,
  task: OrchestrationTask,
  preflightSummary: string,
  feedback: string,
): string {
  return [
    "You are a focused coding worker with write access to this workspace only.",
    "Your approved plan: " + preflightSummary,
    feedback ? "The previous attempt failed. " + feedback : "",
    "",
    packet.rendered,
    "",
    "Make the changes, then reply with a single JSON object and nothing else:",
    WORKER_SCHEMA_DESCRIPTION,
    "",
    "Stay inside: " + task.allowedPaths.join(", "),
    "Publish any interface, schema, or API decision other tasks depend on as an artifact.",
  ]
    .filter(Boolean)
    .join("\n");
}

export { estimateTokens };
