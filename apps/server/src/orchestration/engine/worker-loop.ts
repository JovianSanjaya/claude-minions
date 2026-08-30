import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
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
import { RoleExecutor } from "./role-executor.js";
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
  constructor(public readonly packet: ReturnType<typeof createFailurePacket>) {
    super(packet.lastError);
    this.name = "WorkerLoopError";
  }
}

const addUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
});

function contextText(packet: ContextPacket): string {
  return [
    `Application: ${packet.applicationSummary}`,
    `Task: ${packet.taskObjective}`,
    `Criteria: ${packet.contractCriterionIds.join(", ")}`,
    ...[...packet.source].map(([file, source]) => `\n--- ${file} ---\n${source}`),
  ].join("\n").slice(0, 120_000);
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
  );
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
    const isExactSingleFileScope =
      input.deterministicPreflight === true &&
      task.allowedPaths.length === 1 &&
      /\.[^/]+$/.test(task.allowedPaths[0]!) &&
      task.requiredArtifactIds.length === 0;
    if (isExactSingleFileScope) {
      decision = {
        approved: true,
        reason: "Deterministic preflight approved the exact single-file scope",
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
    const staleTaskIds = new Set<string>();
    for (let number = 1; number <= orchestration.budget.maxWorkerAttempts; number += 1) {
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
        summary: `Started bounded worker attempt ${number}`,
        metadata: { attempt: number },
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
      };
      await this.sink.recordAttempt(started);
      try {
        const call = await this.roles.structured(
          {
            orchestrationId: orchestration.id,
            agentId: orchestration.agentId,
            taskId: task.id,
            role: "worker",
            workspacePath: workspace.path,
            sandboxMode: "workspace-write",
            signal,
            prompt: [
              "Implement only this confirmed task in the writable workspace.",
              `Authoritative allowed edit paths: ${JSON.stringify(task.allowedPaths)}.`,
              "Create or modify only those exact repository-relative paths or their descendants. Do not rename planned files, use /workspace-prefixed paths, create package-boundary placeholders, or edit anything else.",
              "Do not weaken criteria or edit outside allowed paths.",
              contextText(packet),
              `Relevant confirmed acceptance criteria: ${relevantCriteriaText(task, contract)}.`,
              `Attempt: ${number}`,
              "After edits return JSON with summary, diagnosis, and artifacts.",
            ].join("\n"),
          },
          workerResultSchema,
        );
        totalUsage = addUsage(totalUsage, call.usage);
        lastDiagnosis = call.value.diagnosis;
        lastChanges = await this.workspaces.changes(workspace);
        if (!lastChanges.changedFiles.length && !lastChanges.deletedFiles.length) {
          throw new Error("Worker reported completion without making any workspace changes");
        }
        const violations = scopeViolations(lastChanges, task.allowedPaths);
        if (violations.length) throw new Error(`Worker scope violation: ${violations.join(", ")}`);
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
        await this.sink.recordAttempt({
          ...started,
          changedFiles: lastChanges.changedFiles,
          status: signal.aborted ? "cancelled" : "failed",
          usage: totalUsage,
          errorSummary: lastError.slice(0, 2_000),
          completedAt: new Date().toISOString(),
        });
        if (
          number < orchestration.budget.maxWorkerAttempts &&
          /429|too many requests|timed out/i.test(lastError)
        ) {
          const retryDelayMs = 15_000;
          await this.sink.recordEvent({
            orchestrationId: orchestration.id,
            taskId: task.id,
            executionId: null,
            type: "worker-retry-wait",
            actorRole: "control-plane",
            modelId: null,
            summary: "Waiting before retrying a slow or rate-limited model call",
            metadata: { retryDelayMs, nextAttempt: number + 1 },
          });
          await waitForRetry(retryDelayMs, signal);
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
