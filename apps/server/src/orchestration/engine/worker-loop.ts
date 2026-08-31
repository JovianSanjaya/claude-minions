import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RunCancelledError, RunnerExecutionError } from "../../errors.js";
import type {
  BudgetPolicy,
  ExecutionContract,
  Orchestration,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  WorkerAttempt,
} from "../contracts.js";
import type { DetailedApplicationMap } from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker, type ContextPacket } from "./context-broker.js";
import { createFailurePacket } from "./failure-packet.js";
import {
  reviewPreflight,
  workerPreflightSchema,
  type PreflightDecision,
} from "./preflight.js";
import {
  isInternalInfrastructureFailure,
  recoveryDecisionSchema,
  type RecoveryDecision,
} from "./recovery.js";
import { RoleExecutor, type RoleCallResult } from "./role-executor.js";
import { requiredVerificationPassed, VerificationService } from "./verification.js";
import {
  scopeViolations,
  type WorkerWorkspace,
  type WorkerWorkspaceManager,
  type WorkspaceChanges,
} from "./worker-workspaces.js";

const workerResultSchema = z.object({
  summary: z.string().min(1).max(8_000),
  diagnosis: z.string().max(2_000).default(""),
  completed: z.boolean().default(true),
  remainingWork: z.string().max(4_000).default(""),
  artifacts: z.array(z.object({
    id: z.string().min(1).max(200),
    kind: z.enum(["api", "interface", "schema", "decision", "manifest", "test-result"]),
    name: z.string().min(1).max(500),
    payload: z.string().max(8_000),
  })).max(30).default([]),
}).strict();

export interface WorkerLoopResult {
  task: OrchestrationTask;
  workspace: WorkerWorkspace;
  changes: WorkspaceChanges;
  summary: string;
  usage: TokenUsage;
  staleTaskIds: string[];
}

export class WorkerLoopError extends Error {
  constructor(
    public readonly packet: ReturnType<typeof createFailurePacket>,
    public readonly supervisorDecision: RecoveryDecision | null = null,
  ) {
    super(packet.lastError);
    this.name = "WorkerLoopError";
  }
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

function usageFromFailure(error: unknown): TokenUsage {
  const usage = error instanceof RunnerExecutionError || error instanceof RunCancelledError
    ? error.partial?.usage
    : null;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    arkApiTurns: usage?.arkApiTurns ?? 0,
    toolCalls: usage?.toolCalls ?? 0,
    streamRetries: usage?.streamRetries ?? 0,
    peakContextTokens: usage?.peakContextTokens ?? 0,
  };
}

export function isWorkerExecutionBudgetBoundary(value: string): boolean {
  return /ark-turn limit|input-token limit/i.test(value);
}

export function isResumableWorkerTransportFailure(value: string): boolean {
  return /stream disconnected|error sending request|connection reset|connection closed|socket|ECONNRESET|temporar(?:y|ily)|overload|service unavailable|gateway timeout|\b429\b|too many requests|rate limit|timed? out|timeout/i.test(value);
}

export function workerContinuationSegmentLimit(budget: BudgetPolicy): number {
  const turnsPerSegment = Math.max(1, budget.maxArkApiTurnsPerExecution ?? 15);
  const totalTurns = Math.max(turnsPerSegment, budget.maxArkApiTurns ?? 150);
  return Math.max(1, Math.min(100, Math.ceil(totalTurns / turnsPerSegment)));
}

function transientExecutionFailure(value: string): boolean {
  return isWorkerExecutionBudgetBoundary(value) ||
    isResumableWorkerTransportFailure(value) ||
    /timed out|timeout/i.test(value) ||
    isInternalInfrastructureFailure(value);
}

function contextText(packet: ContextPacket): string {
  return [
    `Application: ${packet.applicationSummary}`,
    `Task: ${packet.taskObjective}`,
    `Criteria: ${packet.contractCriterionIds.join(", ")}`,
    ...[...packet.source].map(([file, source]) => `\n--- ${file} ---\n${source}`),
    "Use the supplied excerpts as orientation. Read a complete file from the workspace only when the task actually requires it.",
  ].join("\n").slice(0, 64_000);
}

function relevantCriteriaText(
  task: OrchestrationTask,
  contract: ExecutionContract,
): string {
  const selected = new Set(task.acceptanceCriterionIds);
  return JSON.stringify(
    contract.criteria
      .filter((criterion) => selected.has(criterion.id))
      .map(({ id, kind, description, verification }) => ({ id, kind, description, verification })),
  ).slice(0, 24_000);
}

export function compactChangedPathSummary(
  changes: WorkspaceChanges,
  maximumPaths = 40,
): string {
  const paths = [...changes.changedFiles, ...changes.deletedFiles];
  const visible = paths.slice(0, maximumPaths);
  return JSON.stringify({
    totalChanged: changes.changedFiles.length,
    totalDeleted: changes.deletedFiles.length,
    samplePaths: visible,
    omittedPaths: Math.max(0, paths.length - visible.length),
  });
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Worker cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Worker cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

export class BoundedWorkerLoop {
  constructor(
    private readonly roles: RoleExecutor,
    private readonly sink: OrchestrationSink,
    private readonly verification: VerificationService,
    private readonly workspaces: WorkerWorkspaceManager,
    private readonly broker: ContextBroker,
    private readonly artifacts: ArtifactRegistry,
    private readonly newId: () => string = randomUUID,
  ) {}

  private async saveCheckpoint(input: {
    orchestration: Orchestration;
    task: OrchestrationTask;
    number: number;
    executionId: string;
    changes: WorkspaceChanges;
    usage: TokenUsage;
    threadId: string | null;
    reason: string;
    remainingWork: string;
  }): Promise<boolean> {
    const checkpointed = input.changes.changedFiles.length > 0 || input.changes.deletedFiles.length > 0;
    if (!checkpointed) return false;
    await this.sink.publishArtifact({
      id: `checkpoint-${input.task.id}-${input.number}`,
      orchestrationId: input.orchestration.id,
      producerTaskId: input.task.id,
      kind: "manifest",
      name: `Worker checkpoint ${input.task.title} segment ${input.number}`.slice(0, 500),
      version: input.number,
      payload: JSON.stringify({
        changedFiles: input.changes.changedFiles.slice(0, 100),
        deletedFiles: input.changes.deletedFiles.slice(0, 100),
        reason: input.reason.slice(0, 1_000),
        remainingWork: input.remainingWork.slice(0, 4_000),
        priorThreadId: input.threadId,
        remainingCriteria: input.task.acceptanceCriterionIds,
      }).slice(0, 8_000),
      createdAt: new Date().toISOString(),
    });
    await this.sink.recordEvent({
      orchestrationId: input.orchestration.id,
      taskId: input.task.id,
      executionId: input.executionId,
      type: "worker-checkpoint-saved",
      actorRole: "control-plane",
      modelId: null,
      summary: "Preserved partial worker changes for a bounded continuation",
      metadata: {
        segment: input.number,
        changedFiles: input.changes.changedFiles.length,
        deletedFiles: input.changes.deletedFiles.length,
        arkApiTurns: input.usage.arkApiTurns ?? 0,
      },
    });
    return true;
  }

  async run(input: {
    orchestration: Orchestration;
    contract: ExecutionContract;
    task: OrchestrationTask;
    tasks: OrchestrationTask[];
    map: DetailedApplicationMap;
    mainWorkspacePath: string;
    signal: AbortSignal;
    deterministicPreflight?: boolean;
  }): Promise<WorkerLoopResult> {
    const { orchestration, contract, task, tasks, map, signal } = input;
    const workspace = await this.workspaces.create(
      input.mainWorkspacePath,
      orchestration.id,
      task.id,
      task.allowedPaths,
    );
    task.status = "preflight";
    await this.sink.upsertTask(task);
    await this.sink.recordEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      executionId: null,
      type: "preflight-step",
      actorRole: "control-plane",
      modelId: null,
      summary: "Started bounded read-only worker preflight",
      metadata: { attemptBudget: orchestration.budget.maxWorkerAttempts },
    });
    let packet = await this.broker.createPacket(
      task,
      map,
      contract.version,
      this.artifacts.versionsFor(task),
    );
    await this.sink.recordContextPacket(packet.summary);
    let preflightUsage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let decision: PreflightDecision;
    const useDeterministicPreflight =
      input.deterministicPreflight === true &&
      task.requiredArtifactIds.length === 0;
    if (useDeterministicPreflight) {
      decision = {
        approved: true,
        reason: "Deterministic preflight approved the validated bounded scope and context packet",
        expansionPaths: [],
      };
      await this.sink.recordEvent({
        orchestrationId: orchestration.id,
        taskId: task.id,
        executionId: null,
        type: "preflight-reviewed",
        actorRole: "control-plane",
        modelId: null,
        summary: decision.reason,
        metadata: { approved: true, requestedExpansionCount: 0, deterministic: true },
      });
    } else {
      const preflightPrompt = [
        "Produce a read-only worker preflight as concise JSON. Do not edit files.",
        contextText(packet),
        `Relevant confirmed acceptance criteria: ${relevantCriteriaText(task, contract)}`,
        `Allowed edit paths: ${JSON.stringify(task.allowedPaths)}`,
        `Available additional context files: ${JSON.stringify(map.entries.slice(0, 200).map((entry) => entry.path))}`,
        "missingContext may request only a specific repository-relative file from that list. Use [] when no listed file is required.",
        "Never request /workspace, a directory root, an absolute path, a placeholder, or an unlisted path.",
      ].join("\n");
      let preflightCall = await this.roles.structured(
        {
          orchestrationId: orchestration.id,
          agentId: orchestration.agentId,
          taskId: task.id,
          role: "worker",
          workspacePath: workspace.path,
          sandboxMode: "read-only",
          signal,
          prompt: preflightPrompt,
          maxArkApiTurns: Math.min(4, orchestration.budget.maxArkApiTurnsPerExecution ?? 4),
          maxInputTokens: Math.min(80_000, orchestration.budget.maxInputTokensPerExecution ?? 80_000),
        },
        workerPreflightSchema,
      );
      preflightUsage = preflightCall.usage;
      const availableContextPaths = map.entries.map((entry) => entry.path);
      decision = reviewPreflight(preflightCall.value, task, contract, availableContextPaths);
      await this.sink.recordEvent({
        orchestrationId: orchestration.id,
        taskId: task.id,
        executionId: preflightCall.executionId,
        type: "preflight-reviewed",
        actorRole: "planner",
        modelId: null,
        summary: decision.reason,
        metadata: { approved: decision.approved, requestedExpansionCount: decision.expansionPaths.length },
      });
      if (
        !decision.approved &&
        (decision.reason.startsWith("Preflight would edit paths outside task scope") ||
          decision.reason.startsWith("Preflight requested invalid or unavailable context paths"))
      ) {
        await this.sink.recordEvent({
          orchestrationId: orchestration.id,
          taskId: task.id,
          executionId: preflightCall.executionId,
          type: "preflight-correction-requested",
          actorRole: "control-plane",
          modelId: null,
          summary: "Requested one bounded read-only correction using the authoritative task scope",
          metadata: { allowedPathCount: task.allowedPaths.length },
        });
        preflightCall = await this.roles.structured(
          {
            orchestrationId: orchestration.id,
            agentId: orchestration.agentId,
            taskId: task.id,
            role: "worker",
            workspacePath: workspace.path,
            sandboxMode: "read-only",
            signal,
            prompt: [
              preflightPrompt,
              `The previous preflight was rejected: ${decision.reason}`,
              `expectedFiles must be a subset of: ${JSON.stringify(task.allowedPaths)}.`,
              `missingContext must be [] unless it names a file from: ${JSON.stringify(availableContextPaths.slice(0, 200))}.`,
            ].join("\n"),
            maxArkApiTurns: Math.min(4, orchestration.budget.maxArkApiTurnsPerExecution ?? 4),
            maxInputTokens: Math.min(80_000, orchestration.budget.maxInputTokensPerExecution ?? 80_000),
          },
          workerPreflightSchema,
        );
        preflightUsage = addUsage(preflightUsage, preflightCall.usage);
        decision = reviewPreflight(preflightCall.value, task, contract, availableContextPaths);
        await this.sink.recordEvent({
          orchestrationId: orchestration.id,
          taskId: task.id,
          executionId: preflightCall.executionId,
          type: "preflight-reviewed",
          actorRole: "planner",
          modelId: null,
          summary: decision.reason,
          metadata: { approved: decision.approved, requestedExpansionCount: decision.expansionPaths.length, correction: true },
        });
      }
    }
    if (!decision.approved) {
      await this.workspaces.cleanup(workspace, "archive");
      throw new Error(decision.reason);
    }
    if (decision.expansionPaths.length) {
      packet = await this.broker.expand(
        task,
        map,
        contract.version,
        this.artifacts.versionsFor(task),
        decision.expansionPaths,
        "Worker preflight identified required interfaces",
      );
      await this.sink.recordContextPacket(packet.summary);
      await this.sink.recordEvent({
        orchestrationId: orchestration.id,
        taskId: task.id,
        executionId: null,
        type: "context-expansion",
        actorRole: "control-plane",
        modelId: null,
        summary: "Narrow preflight context expansion granted",
        metadata: { fileCount: packet.summary.sourceFiles.length },
      });
    }

    let totalUsage: TokenUsage = preflightUsage;
    let lastError = "Worker did not complete";
    let lastDiagnosis = "";
    let lastChanges: WorkspaceChanges = { changedFiles: [], deletedFiles: [], hashes: {} };
    let lastVerifications: Awaited<ReturnType<VerificationService["run"]>> = [];
    let supervisorGuidance = "";
    let lastThreadId: string | null = null;
    let resumeThreadId: string | null = null;
    const staleTaskIds = new Set<string>();
    const maximumFailureAttempts = Math.max(1, orchestration.budget.maxWorkerAttempts);
    const maximumContinuationSegments = workerContinuationSegmentLimit(orchestration.budget);
    let failureAttempts = 0;
    let segmentNumber = 0;
    while (
      failureAttempts < maximumFailureAttempts &&
      segmentNumber < maximumContinuationSegments
    ) {
      segmentNumber += 1;
      const number = failureAttempts + 1;
      if (signal.aborted) throw new Error("Worker cancelled");
      task.status = "running";
      task.attemptCount = number;
      await this.sink.upsertTask(task);
      await this.sink.recordEvent({
        orchestrationId: orchestration.id,
        taskId: task.id,
        executionId: null,
        type: "worker-step",
        actorRole: "control-plane",
        modelId: null,
        summary: `Started worker segment ${segmentNumber} (failure attempt ${number})`,
        metadata: {
          attempt: number,
          segment: segmentNumber,
          maximumFailureAttempts,
          maximumContinuationSegments,
        },
      });
      const attemptId = this.newId();
      const executionId = this.newId();
      const started: WorkerAttempt = {
        id: attemptId,
        orchestrationId: orchestration.id,
        taskId: task.id,
        number,
        executionId,
        modelId: "pending",
        contextFileHashes: packet.summary.sourceFiles.map((file) => file.sha256),
        changedFiles: [],
        status: "running",
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        errorSummary: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
        threadId: null,
        checkpointed: false,
      };
      await this.sink.recordAttempt(started);
      let attemptUsage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      try {
        const hardTurnLimit = orchestration.budget.maxArkApiTurnsPerExecution ?? 15;
        const hardInputLimit = orchestration.budget.maxInputTokensPerExecution ?? 250_000;
        const checkpointTurnTarget = Math.max(1, hardTurnLimit - Math.max(2, Math.ceil(hardTurnLimit * 0.2)));
        const checkpointInputTarget = Math.max(1, Math.floor(hardInputLimit * 0.8));
        const retryContext = segmentNumber === 1
          ? contextText(packet)
          : [
              `Checkpointed workspace summary: ${compactChangedPathSummary(lastChanges)}`,
              `Relevant interfaces: ${JSON.stringify(packet.summary.relevantInterfaces)}`,
              "Continue from the current workspace state. Do not repeat completed exploration or recreate files that already exist.",
            ].join("\n");
        const call: RoleCallResult<z.infer<typeof workerResultSchema>> = await this.roles.structured(
          {
            orchestrationId: orchestration.id,
            agentId: orchestration.agentId,
            taskId: task.id,
            role: "worker",
            workspacePath: workspace.path,
            sandboxMode: "workspace-write",
            allowedWritePaths: task.allowedPaths,
            signal,
            prompt: [
              "Implement only this confirmed task in the writable workspace.",
              `Task: ${task.title}: ${task.objective}`,
              `Authoritative allowed edit paths: ${JSON.stringify(task.allowedPaths)}.`,
              "Create or modify only those exact repository-relative paths or their descendants. Do not rename planned files, use /workspace-prefixed paths, create package-boundary placeholders, or edit anything else.",
              "Do not weaken criteria or edit outside allowed paths.",
              retryContext,
              `Relevant confirmed acceptance criteria: ${relevantCriteriaText(task, contract)}.`,
              `Failure attempt: ${number}. Continuation segment: ${segmentNumber}.`,
              `This bounded work segment has a hard ceiling of ${hardTurnLimit} raw model turns and ${hardInputLimit} cumulative input tokens. Aim to stop by about ${checkpointTurnTarget} turns or ${checkpointInputTarget} input tokens so there is room to return the response contract.`,
              ...(supervisorGuidance
                ? [
                    `Previous attempt failure: ${lastError}`,
                    `Big-model supervisor guidance: ${supervisorGuidance}`,
                    "Use that guidance to change the approach. Inspect the current workspace state before editing.",
                  ]
                : []),
              "Keep tool output compact: batch related inspection, use targeted searches, and never print full dependency trees, generated files, or long successful logs.",
              "Checkpoint by leaving every completed edit in the workspace. If the entire assigned task is finished, return completed=true and remainingWork as an empty string. If this segment reaches its target before the task is finished, return completed=false with a precise remainingWork handoff. Always return the JSON response before beginning another large exploration phase.",
            ].join("\n"),
            maxArkApiTurns: orchestration.budget.maxArkApiTurnsPerExecution,
            maxInputTokens: orchestration.budget.maxInputTokensPerExecution,
            threadId: resumeThreadId,
          },
          workerResultSchema,
        );
        lastThreadId = call.threadId;
        attemptUsage = call.usage;
        totalUsage = addUsage(totalUsage, call.usage);
        lastDiagnosis = call.value.diagnosis;
        lastChanges = await this.workspaces.changes(workspace);
        if (!lastChanges.changedFiles.length && !lastChanges.deletedFiles.length) {
          throw new Error("Worker reported completion without making any workspace changes");
        }
        const violations = scopeViolations(lastChanges, task.allowedPaths);
        if (violations.length) throw new Error(`Worker scope violation: ${violations.join(", ")}`);
        if (!call.value.completed) {
          lastError = call.value.remainingWork
            ? `Worker saved a bounded checkpoint with remaining work: ${call.value.remainingWork}`
            : "Worker saved a bounded checkpoint before completing the assigned task";
          const checkpointed = await this.saveCheckpoint({
            orchestration,
            task,
            number: segmentNumber,
            executionId: call.executionId,
            changes: lastChanges,
            usage: call.usage,
            threadId: call.threadId,
            reason: call.value.summary,
            remainingWork: call.value.remainingWork,
          });
          await this.sink.recordAttempt({
            ...started,
            executionId: call.executionId,
            modelId: call.actualModelId,
            changedFiles: lastChanges.changedFiles,
            status: "checkpointed",
            usage: call.usage,
            errorSummary: null,
            completedAt: new Date().toISOString(),
            threadId: call.threadId,
            checkpointed,
          });
          if (segmentNumber < maximumContinuationSegments) {
            supervisorGuidance = call.value.remainingWork || call.value.summary;
            resumeThreadId = null;
            await this.sink.recordEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              executionId: call.executionId,
              type: "worker-compact-continuation",
              actorRole: "control-plane",
              modelId: null,
              summary: "Worker reached a planned checkpoint and will continue in a fresh compact session",
              metadata: {
                segment: segmentNumber,
                nextSegment: segmentNumber + 1,
                checkpointed,
                resumesThread: false,
                graceful: true,
              },
            });
            continue;
          }
          break;
        }
        lastVerifications = await this.verification.run(
          orchestration.id,
          task.id,
          workspace.path,
          ["worker-visible"],
          this.sink,
          signal,
        );
        if (!requiredVerificationPassed(lastVerifications)) {
          throw new Error("Worker-visible verification failed");
        }
        for (const output of call.value.artifacts) {
          const latest = this.artifacts.latest(output.id);
          const artifact: SharedArtifact = {
            ...output,
            orchestrationId: orchestration.id,
            producerTaskId: task.id,
            version: (latest?.version ?? 0) + 1,
            createdAt: new Date().toISOString(),
          };
          for (const staleId of await this.artifacts.publish(artifact, tasks)) staleTaskIds.add(staleId);
        }
        task.status = "passed";
        await this.sink.upsertTask(task);
        await this.sink.recordAttempt({
          ...started,
          executionId: call.executionId,
          modelId: call.actualModelId,
          changedFiles: lastChanges.changedFiles,
          status: "passed",
          usage: call.usage,
          completedAt: new Date().toISOString(),
          threadId: call.threadId,
          checkpointed: true,
        });
        return {
          task,
          workspace,
          changes: lastChanges,
          summary: call.value.summary,
          usage: totalUsage,
          staleTaskIds: [...staleTaskIds],
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        lastChanges = await this.workspaces.changes(workspace).catch(() => lastChanges);
        const unsafeChanges = scopeViolations(lastChanges, task.allowedPaths);
        if (unsafeChanges.length) {
          try {
            const sanitized = await this.workspaces.sanitizeScopeViolations(workspace);
            lastChanges = sanitized.changes;
            await this.sink.recordEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              executionId: started.executionId,
              type: "worker-scope-sanitized",
              actorRole: "control-plane",
              modelId: null,
              summary: "Removed unauthorized worker changes before preserving the retry checkpoint",
              metadata: {
                restoredPathCount: sanitized.restoredPaths.length,
                retainedChangedFiles: sanitized.changes.changedFiles.length,
                retainedDeletedFiles: sanitized.changes.deletedFiles.length,
              },
            });
          } catch (sanitizationError) {
            await this.sink.recordEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              executionId: started.executionId,
              type: "worker-scope-sanitization-failed",
              actorRole: "control-plane",
              modelId: null,
              summary: "Could not restore the isolated worker workspace to its authorized scope; retry stopped safely",
              metadata: {
                violationCount: unsafeChanges.length,
                error: sanitizationError instanceof Error
                  ? sanitizationError.message.slice(0, 1_000)
                  : String(sanitizationError).slice(0, 1_000),
              },
            });
            throw new Error(
              `Worker scope restoration failed safely: ${sanitizationError instanceof Error ? sanitizationError.message : String(sanitizationError)}`,
            );
          }
        }
        const partialUsage = usageFromFailure(error);
        const attemptAlreadyCounted = attemptUsage.inputTokens > 0 ||
          attemptUsage.outputTokens > 0 ||
          (attemptUsage.arkApiTurns ?? 0) > 0;
        if (!attemptAlreadyCounted) {
          attemptUsage = partialUsage;
          totalUsage = addUsage(totalUsage, partialUsage);
        }
        const failedUsage = attemptUsage;
        const failedThreadId: string | null = error instanceof RunnerExecutionError || error instanceof RunCancelledError
          ? error.partial?.threadId ?? lastThreadId
          : lastThreadId;
        const budgetBoundary = isWorkerExecutionBudgetBoundary(lastError);
        const resumableTransportFailure = isResumableWorkerTransportFailure(lastError);
        const transientFailure = transientExecutionFailure(lastError);
        resumeThreadId = resumableTransportFailure ? failedThreadId : null;
        const checkpointViolations = scopeViolations(lastChanges, task.allowedPaths);
        if (checkpointViolations.length) {
          throw new Error(`Refusing to checkpoint unauthorized worker changes: ${checkpointViolations.join(", ")}`);
        }
        const checkpointed = await this.saveCheckpoint({
          orchestration,
          task,
          number: segmentNumber,
          executionId: started.executionId,
          changes: lastChanges,
          usage: failedUsage,
          threadId: failedThreadId,
          reason: lastError,
          remainingWork: "Continue the unfinished acceptance criteria from the current workspace state.",
        });
        await this.sink.recordAttempt({
          ...started,
          changedFiles: lastChanges.changedFiles,
          status: signal.aborted ? "cancelled" : budgetBoundary && checkpointed ? "checkpointed" : "failed",
          usage: failedUsage,
          errorSummary: budgetBoundary && checkpointed ? null : lastError.slice(0, 2_000),
          completedAt: new Date().toISOString(),
          threadId: failedThreadId,
          checkpointed,
        });
        if (resumableTransportFailure) {
          await this.sink.recordEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            executionId: started.executionId,
            type: "worker-transport-retries-exhausted",
            actorRole: "control-plane",
            modelId: null,
            summary: "The model connection remained unavailable after its independent transport retries",
            metadata: {
              segment: segmentNumber,
              failureAttempt: number,
              checkpointed,
              resumesThread: Boolean(resumeThreadId),
            },
          });
          break;
        }
        if (transientFailure) {
          if (segmentNumber < maximumContinuationSegments) {
            supervisorGuidance = [
              budgetBoundary
                ? "The previous bounded work segment reached its per-execution turn or input-token checkpoint."
                : "The previous execution stopped for a transient transport or Runtime condition.",
              "Continue from the checkpointed workspace, finish only remaining work, batch commands, and return the required JSON promptly.",
            ].join(" ");
            await this.sink.recordEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              executionId: started.executionId,
              type: "worker-compact-continuation",
              actorRole: "control-plane",
              modelId: null,
              summary: budgetBoundary
                ? "Worker reached a hard checkpoint boundary and will continue in a fresh compact session"
                : resumeThreadId
                  ? "Transient transport failure will resume the existing worker thread from its checkpoint"
                  : "Transient Runtime failure will continue in a fresh worker session from its checkpoint",
              metadata: {
                segment: segmentNumber,
                nextSegment: segmentNumber + 1,
                checkpointed,
                resumesThread: Boolean(resumeThreadId),
                budgetBoundary,
                graceful: false,
              },
            });
            await waitForRetry(Math.min(4_000, 500 * (2 ** (segmentNumber - 1))), signal);
            continue;
          }
          break;
        }
        failureAttempts += 1;
        task.attemptCount = failureAttempts;
        if (failureAttempts < maximumFailureAttempts) {
          const failurePacket = createFailurePacket({
            taskId: task.id,
            contractVersion: contract.version,
            attemptCount: failureAttempts,
            error: lastError,
            verifications: lastVerifications,
            changes: lastChanges,
            relevantInterfaces: packet.summary.relevantInterfaces,
            diagnosis: lastDiagnosis,
            usage: totalUsage,
          });
          await this.sink.recordEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            executionId: null,
            type: "worker-supervisor-escalation",
            actorRole: "control-plane",
            modelId: null,
            summary: "Worker failure was escalated to the big-model supervisor before retry",
            metadata: { attempt: failureAttempts, nextAttempt: failureAttempts + 1 },
          });
          try {
            const supervised = await this.roles.structured(
              {
                orchestrationId: orchestration.id,
                agentId: orchestration.agentId,
                taskId: task.id,
                role: "planner",
                workspacePath: workspace.path,
                sandboxMode: "read-only",
                signal,
                prompt: [
                  "Act as the big-model supervisor for a smaller implementation worker.",
                  "Diagnose the failed attempt and decide whether the worker should retry with changed instructions, whether only the user can unblock it, or whether it is genuinely non-recoverable.",
                  "At this phase use retry-worker for self-repair. Do not choose retry-integrator or retry-verifier.",
                  "Choose needs-user only for a permission, credential, material product choice, or external action that the system cannot perform itself.",
                  "Give concrete instructions that the next small-worker attempt can execute. Do not merely restate the error.",
                  `Task: ${JSON.stringify({ id: task.id, objective: task.objective, allowedPaths: task.allowedPaths })}`,
                  `Confirmed contract: ${JSON.stringify({ version: contract.version, goal: contract.intent.goal, criteria: contract.criteria.filter((criterion) => task.acceptanceCriterionIds.includes(criterion.id)).map(({ id, kind, description }) => ({ id, kind, description: description.slice(0, 800) })) })}`,
                  `Failure packet: ${JSON.stringify(failurePacket)}`,
                ].join("\n").slice(0, 40_000),
                maxArkApiTurns: Math.min(8, orchestration.budget.maxArkApiTurnsPerExecution ?? 8),
                maxInputTokens: Math.min(120_000, orchestration.budget.maxInputTokensPerExecution ?? 120_000),
              },
              recoveryDecisionSchema,
            );
            const decision: RecoveryDecision = isInternalInfrastructureFailure(lastError)
              ? {
                  ...supervised.value,
                  classification: "transient-failure",
                  action: "retry-worker",
                  reason: "The Runtime launcher failed internally; retry the worker from its compact checkpoint.",
                  instructions: "Continue from the workspace checkpoint. Do not enumerate generated cache files or repeat completed work.",
                  targetTaskIds: [task.id],
                  userQuestion: null,
                }
              : supervised.value.action === "retry-direct"
                ? { ...supervised.value, action: "retry-worker" }
                : supervised.value;
            await this.sink.recordEvent({
              orchestrationId: orchestration.id,
              taskId: task.id,
              executionId: supervised.executionId,
              type: "worker-supervisor-decision",
              actorRole: "planner",
              modelId: supervised.actualModelId,
              summary: decision.reason,
              metadata: {
                attempt: failureAttempts,
                classification: decision.classification,
                action: decision.action,
              },
            });
            if (decision.action === "needs-user" || decision.action === "stop") {
              await this.workspaces.cleanup(workspace, "archive");
              throw new WorkerLoopError(failurePacket, decision);
            }
            supervisorGuidance = decision.instructions || decision.reason;
          } catch (supervisorError) {
            if (supervisorError instanceof WorkerLoopError) throw supervisorError;
            const supervisorReason = supervisorError instanceof Error
              ? supervisorError.message
              : String(supervisorError);
            if (/budget denied/i.test(supervisorReason)) throw supervisorError;
            supervisorGuidance = [
              `The supervisor call failed: ${supervisorReason}`,
              `Independently correct the prior worker failure: ${lastError}`,
            ].join("\n");
          }
        }
      }
    }
    task.status = "failed";
    await this.sink.upsertTask(task);
    await this.workspaces.cleanup(workspace, "archive");
    throw new WorkerLoopError(
      createFailurePacket({
        taskId: task.id,
        contractVersion: contract.version,
        attemptCount: task.attemptCount,
        error: lastError,
        verifications: lastVerifications,
        changes: lastChanges,
        relevantInterfaces: packet.summary.relevantInterfaces,
        diagnosis: lastDiagnosis,
        usage: totalUsage,
      }),
    );
  }
}
