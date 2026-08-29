import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ExecutionContract,
  FailurePacket,
  OrchestrationSink,
  OrchestrationTask,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { createFailurePacket } from "./failure-packet.js";
import { PreflightService } from "./preflight.js";
import { BudgetDeniedError, RoleExecutor } from "./role-executor.js";
import { VerificationService } from "./verification.js";
import {
  WorkerWorkspaceManager,
  type ChangedFileManifest,
  type WorkerWorkspace,
} from "./worker-workspaces.js";

const workerOutputSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    diagnosis: z.string().max(2_000),
    artifacts: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200).optional(),
            kind: z.enum(["api", "interface", "schema", "decision", "manifest", "test-result"]),
            name: z.string().min(1).max(200),
            payload: z.string().max(20_000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

export interface PassedWorkerTask {
  kind: "passed";
  task: OrchestrationTask;
  workspace: WorkerWorkspace;
  manifest: ChangedFileManifest;
  summary: string;
  usage: TokenUsage;
}

export interface FailedWorkerTask {
  kind: "failed";
  task: OrchestrationTask;
  workspace: WorkerWorkspace | null;
  manifest: ChangedFileManifest | null;
  packet: FailurePacket;
}

export type WorkerTaskResult =
  | PassedWorkerTask
  | FailedWorkerTask
  | { kind: "budget-exhausted"; reason: string; workspace: WorkerWorkspace | null }
  | { kind: "cancelled"; reason: string; workspace: WorkerWorkspace | null };

const emptyUsage = (): TokenUsage => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
function addUsage(total: TokenUsage, next: TokenUsage): void {
  total.inputTokens += next.inputTokens;
  total.cachedInputTokens += next.cachedInputTokens;
  total.outputTokens += next.outputTokens;
}

export class WorkerLoop {
  constructor(
    private readonly roles: RoleExecutor,
    private readonly broker: ContextBroker,
    private readonly preflights: PreflightService,
    private readonly workspaces: WorkerWorkspaceManager,
    private readonly verification: VerificationService,
    private readonly artifacts: ArtifactRegistry,
  ) {}

  async execute(input: {
    orchestrationId: string;
    agentId: string;
    task: OrchestrationTask;
    allTasks: OrchestrationTask[];
    contract: ExecutionContract;
    map: ApplicationMap;
    sink: OrchestrationSink;
    signal: AbortSignal;
    maxAttempts: number;
    maxContextExpansions: number;
  }): Promise<WorkerTaskResult> {
    let workspace: WorkerWorkspace | null = null;
    const totalUsage = emptyUsage();
    let lastError = "Worker did not start";
    let lastDiagnosis = "";
    let lastManifest: ChangedFileManifest | null = null;
    let failingChecks: string[] = [];
    try {
      input.task.status = "preflight";
      await input.sink.upsertTask(input.task);
      const context = await this.broker.createPacket({
        map: input.map,
        task: input.task,
        contract: input.contract,
        artifacts: this.artifacts.list(input.orchestrationId),
        sink: input.sink,
      });
      workspace = await this.workspaces.create(
        input.orchestrationId,
        input.task,
        input.map,
        context.sources.map((source) => source.path),
      );
      const preflight = await this.preflights.run({
        orchestrationId: input.orchestrationId,
        agentId: input.agentId,
        task: input.task,
        contract: input.contract,
        map: input.map,
        context,
        workspacePath: workspace.workspacePath,
        maxContextExpansions: input.maxContextExpansions,
        sink: input.sink,
        signal: input.signal,
      });
      if (!preflight.approved) {
        lastError = `Preflight rejected: ${preflight.reason}`;
        input.task.status = "failed";
        await input.sink.upsertTask(input.task);
        return {
          kind: "failed",
          task: input.task,
          workspace,
          manifest: null,
          packet: createFailurePacket({
            taskId: input.task.id,
            contractVersion: input.contract.version,
            attemptCount: 0,
            lastError,
            failingChecks: [],
            changedFiles: [],
            diffSummary: "No writable execution occurred.",
            relevantInterfaces: context.summary.relevantInterfaces,
            workerDiagnosis: preflight.preflight.understanding,
            usage: totalUsage,
          }),
        };
      }

      input.task.status = "running";
      await input.sink.upsertTask(input.task);
      for (let attemptNumber = 1; attemptNumber <= input.maxAttempts; attemptNumber += 1) {
        if (input.signal.aborted) {
          input.task.status = "cancelled";
          await input.sink.upsertTask(input.task);
          return { kind: "cancelled", reason: "Orchestration cancelled", workspace };
        }
        input.task.attemptCount = attemptNumber;
        const attemptId = randomUUID();
        const startedAt = new Date().toISOString();
        const attempt: WorkerAttempt = {
          id: attemptId,
          orchestrationId: input.orchestrationId,
          taskId: input.task.id,
          number: attemptNumber,
          executionId: "pending",
          modelId: "pending",
          contextFileHashes: preflight.context.summary.sourceFiles.map((file) => file.sha256),
          changedFiles: [],
          status: "running",
          usage: emptyUsage(),
          errorSummary: null,
          createdAt: startedAt,
          completedAt: null,
        };
        await input.sink.recordAttempt(attempt);
        try {
          const response = await this.roles.callStructured(
            {
              orchestrationId: input.orchestrationId,
              taskId: input.task.id,
              agentId: input.agentId,
              role: "worker",
              prompt: [
                "Execute the approved coding subtask in this isolated writable workspace.",
                "Change only allowed paths. Do not inspect protected evaluators or unrelated paths.",
                `Objective: ${input.task.objective}`,
                `Allowed paths: ${input.task.allowedPaths.join(", ")}`,
                `Acceptance criteria: ${preflight.context.contractExcerpt.join(" | ")}`,
                `Approved approach: ${preflight.preflight.approach.join("; ")}`,
                `Current artifact versions: ${JSON.stringify(preflight.context.summary.artifactVersions)}`,
                attemptNumber > 1 ? `Previous safe failure: ${lastError.slice(0, 2_000)}` : "",
                "After editing, return JSON summarizing the work, a concise diagnosis, and structured artifacts. Do not include hidden reasoning.",
              ]
                .filter(Boolean)
                .join("\n\n"),
              workspacePath: workspace.workspacePath,
              sandboxMode: "workspace-write",
              estimatedInputTokens: preflight.context.summary.estimatedTokens + 1_500,
              estimatedOutputTokens: 2_000,
              sink: input.sink,
              signal: input.signal,
            },
            workerOutputSchema,
            "{summary:string,diagnosis:string,artifacts:{id?:string,kind:'api'|'interface'|'schema'|'decision'|'manifest'|'test-result',name:string,payload:string}[]}",
          );
          addUsage(totalUsage, response.usage);
          lastDiagnosis = response.value.diagnosis;
          lastManifest = await this.workspaces.inspect(workspace);
          attempt.executionId = response.executionId;
          attempt.modelId = response.modelId;
          attempt.changedFiles = lastManifest.files.map((file) => file.path);
          attempt.usage = response.usage;

          const scopeRecord: VerificationRecord = {
            id: randomUUID(),
            orchestrationId: input.orchestrationId,
            taskId: input.task.id,
            scope: "worker-visible",
            commandOrCheck: "allowed-path-scope",
            status: lastManifest.scopeViolations.length === 0 ? "passed" : "failed",
            outputSummary:
              lastManifest.scopeViolations.length === 0
                ? `${lastManifest.files.length} changed files stayed inside the approved scope.`
                : `Out-of-scope changes: ${lastManifest.scopeViolations.join(", ")}`.slice(0, 4_000),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
          await input.sink.recordVerification(scopeRecord);
          const visible = await this.verification.run({
            orchestrationId: input.orchestrationId,
            taskId: input.task.id,
            workspacePath: workspace.workspacePath,
            scopes: ["worker-visible"],
            sink: input.sink,
            signal: input.signal,
          });
          failingChecks = [scopeRecord, ...visible.records]
            .filter((record) => record.status === "failed")
            .map((record) => `${record.commandOrCheck}: ${record.outputSummary}`);
          if (failingChecks.length === 0) {
            for (const publication of response.value.artifacts) {
              await this.artifacts.publish({
                orchestrationId: input.orchestrationId,
                producerTaskId: input.task.id,
                publication: {
                  ...(publication.id ? { id: publication.id } : {}),
                  kind: publication.kind,
                  name: publication.name,
                  payload: publication.payload,
                },
                tasks: input.allTasks,
                sink: input.sink,
              });
            }
            attempt.status = "passed";
            attempt.completedAt = new Date().toISOString();
            await input.sink.recordAttempt(attempt);
            input.task.status = "passed";
            await input.sink.upsertTask(input.task);
            return {
              kind: "passed",
              task: input.task,
              workspace,
              manifest: lastManifest,
              summary: response.value.summary,
              usage: totalUsage,
            };
          }
          lastError = failingChecks.at(-1) ?? "Visible verification failed";
          attempt.status = "failed";
          attempt.errorSummary = lastError.slice(0, 2_000);
          attempt.completedAt = new Date().toISOString();
          await input.sink.recordAttempt(attempt);
        } catch (error) {
          if (error instanceof BudgetDeniedError) {
            return { kind: "budget-exhausted", reason: error.reason, workspace };
          }
          if (input.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            return { kind: "cancelled", reason: "Orchestration cancelled", workspace };
          }
          lastError = error instanceof Error ? error.message : String(error);
          attempt.status = "failed";
          attempt.errorSummary = lastError.slice(0, 2_000);
          attempt.completedAt = new Date().toISOString();
          await input.sink.recordAttempt(attempt);
        }
      }
      input.task.status = "failed";
      await input.sink.upsertTask(input.task);
      return {
        kind: "failed",
        task: input.task,
        workspace,
        manifest: lastManifest,
        packet: createFailurePacket({
          taskId: input.task.id,
          contractVersion: input.contract.version,
          attemptCount: input.task.attemptCount,
          lastError,
          failingChecks,
          changedFiles: lastManifest?.files.map((file) => file.path) ?? [],
          diffSummary: `${lastManifest?.files.length ?? 0} files changed; ${lastManifest?.scopeViolations.length ?? 0} scope violations.`,
          relevantInterfaces: preflight.context.summary.relevantInterfaces,
          workerDiagnosis: lastDiagnosis,
          usage: totalUsage,
        }),
      };
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        return { kind: "budget-exhausted", reason: error.reason, workspace };
      }
      if (input.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return { kind: "cancelled", reason: "Orchestration cancelled", workspace };
      }
      lastError = error instanceof Error ? error.message : String(error);
      input.task.status = "failed";
      await input.sink.upsertTask(input.task);
      return {
        kind: "failed",
        task: input.task,
        workspace,
        manifest: lastManifest,
        packet: createFailurePacket({
          taskId: input.task.id,
          contractVersion: input.contract.version,
          attemptCount: input.task.attemptCount,
          lastError,
          failingChecks,
          changedFiles: lastManifest?.files.map((file) => file.path) ?? [],
          diffSummary: "Worker loop stopped before local acceptance.",
          relevantInterfaces: [],
          workerDiagnosis: lastDiagnosis,
          usage: totalUsage,
        }),
      };
    }
  }
}
