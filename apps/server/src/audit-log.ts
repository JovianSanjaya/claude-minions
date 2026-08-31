import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { redactClone, redactString } from "./orchestration/control/redaction.js";
import type {
  OrchestrationDatabase,
  OrchestrationMutationObserver,
} from "./orchestration/control/store.js";

export interface AuditEntry {
  timestamp: string;
  category: "system" | "http" | "model" | "orchestration";
  action: string;
  outcome: "started" | "completed" | "failed" | "cancelled" | "info";
  orchestrationId: string | null;
  taskId: string | null;
  executionId: string | null;
  agentId: string | null;
  durationMs: number | null;
  data: Record<string, unknown>;
}

export interface AuditLogOptions {
  directory: string;
  enabled?: boolean;
  maximumBytes?: number;
  maximumFiles?: number;
  clock?: () => Date;
}

export type AuditWrite = Omit<AuditEntry, "timestamp"> & { timestamp?: string };

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export function contentFingerprint(value: string): { characters: number; sha256: string } {
  return {
    characters: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

export class AuditLog {
  private pending: Promise<void> = Promise.resolve();
  private readonly enabled: boolean;
  private readonly maximumBytes: number;
  private readonly maximumFiles: number;
  private readonly now: () => Date;

  constructor(private readonly options: AuditLogOptions) {
    this.enabled = options.enabled ?? true;
    this.maximumBytes = options.maximumBytes ?? 25 * 1024 * 1024;
    this.maximumFiles = options.maximumFiles ?? 5;
    this.now = options.clock ?? (() => new Date());
  }

  get globalPath(): string {
    return path.join(this.options.directory, "audit.jsonl");
  }

  orchestrationPath(orchestrationId: string): string {
    return path.join(this.options.directory, "orchestrations", `${safeId(orchestrationId)}.jsonl`);
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(path.join(this.options.directory, "orchestrations"), { recursive: true, mode: 0o700 });
  }

  write(input: AuditWrite): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const entry: AuditEntry = redactClone({
      ...input,
      timestamp: input.timestamp ?? this.now().toISOString(),
      data: input.data ?? {},
    });
    this.pending = this.pending
      .catch(() => undefined)
      .then(async () => {
        const line = `${JSON.stringify(entry)}\n`;
        await this.appendRotated(this.globalPath, line);
        if (entry.orchestrationId) {
          await this.appendRotated(this.orchestrationPath(entry.orchestrationId), line);
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[audit-log] ${redactString(message, 2_000)}\n`);
      });
    return this.pending;
  }

  async readOrchestration(orchestrationId: string, limit = 500): Promise<AuditEntry[]> {
    await this.pending.catch(() => undefined);
    if (!this.enabled) return [];
    const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    try {
      const text = await readFile(this.orchestrationPath(orchestrationId), "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-boundedLimit)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private async appendRotated(file: string, line: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const currentBytes = await stat(file).then((value) => value.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > this.maximumBytes) {
      await this.rotate(file);
    }
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  }

  private async rotate(file: string): Promise<void> {
    await rm(`${file}.${this.maximumFiles}`, { force: true });
    for (let index = this.maximumFiles - 1; index >= 1; index -= 1) {
      await rename(`${file}.${index}`, `${file}.${index + 1}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rename(file, `${file}.1`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function byId<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function changed<T>(previous: T | undefined, next: T): boolean {
  return previous === undefined || JSON.stringify(previous) !== JSON.stringify(next);
}

export function createOrchestrationAuditObserver(audit: AuditLog): OrchestrationMutationObserver {
  return (previous: OrchestrationDatabase, next: OrchestrationDatabase) => {
    const append = (input: AuditWrite) => { void audit.write(input); };
    const oldEvents = new Set(previous.events.map((event) => event.id));
    for (const event of next.events) {
      if (oldEvents.has(event.id)) continue;
      append({
        timestamp: event.createdAt,
        category: "orchestration", action: event.type, outcome: "info",
        orchestrationId: event.orchestrationId, taskId: event.taskId,
        executionId: event.executionId, agentId: null, durationMs: null,
        data: {
          actorRole: event.actorRole,
          modelId: event.modelId,
          summary: event.summary,
          metadata: event.metadata,
        },
      });
    }

    const oldOrchestrations = byId(previous.orchestrations);
    for (const item of next.orchestrations) {
      const old = oldOrchestrations.get(item.id);
      if (!old || old.status !== item.status || old.error !== item.error || old.finalOutput !== item.finalOutput) {
        append({
          category: "orchestration", action: "state", outcome: item.status === "failed" ? "failed" : "info",
          orchestrationId: item.id, taskId: null, executionId: null, agentId: item.agentId, durationMs: null,
          data: {
            previousStatus: old?.status ?? null,
            status: item.status,
            selectedMode: item.selectedMode,
            error: item.error,
            finalOutput: item.finalOutput,
            usage: item.usage,
            budget: item.budget,
          },
        });
      }
    }

    const oldTasks = byId(previous.tasks);
    for (const task of next.tasks) {
      if (!changed(oldTasks.get(task.id), task)) continue;
      append({
        category: "orchestration", action: "task-state", outcome: task.status === "failed" ? "failed" : "info",
        orchestrationId: task.orchestrationId, taskId: task.id, executionId: null, agentId: null, durationMs: null,
        data: {
          title: task.title,
          status: task.status,
          attemptCount: task.attemptCount,
          dependencies: task.dependsOn,
          allowedPaths: task.allowedPaths,
          acceptanceCriterionIds: task.acceptanceCriterionIds,
        },
      });
    }

    const oldAttempts = byId(previous.attempts);
    for (const attempt of next.attempts) {
      if (!changed(oldAttempts.get(attempt.id), attempt)) continue;
      append({
        category: "orchestration", action: "worker-attempt",
        outcome: attempt.status === "failed" ? "failed" : attempt.status === "cancelled" ? "cancelled" : "info",
        orchestrationId: attempt.orchestrationId, taskId: attempt.taskId,
        executionId: attempt.executionId, agentId: null, durationMs: null,
        data: {
          number: attempt.number,
          status: attempt.status,
          modelId: attempt.modelId,
          changedFiles: attempt.changedFiles,
          usage: attempt.usage,
          checkpointed: attempt.checkpointed,
          error: attempt.errorSummary,
          threadId: attempt.threadId,
        },
      });
    }

    const oldVerifications = byId(previous.verifications);
    for (const verification of next.verifications) {
      if (!changed(oldVerifications.get(verification.id), verification)) continue;
      append({
        category: "orchestration", action: "verification",
        outcome: verification.status === "failed" ? "failed" : "info",
        orchestrationId: verification.orchestrationId, taskId: verification.taskId,
        executionId: null, agentId: null, durationMs: null,
        data: { ...verification },
      });
    }

    const oldArtifacts = byId(previous.artifacts);
    for (const artifact of next.artifacts) {
      if (!changed(oldArtifacts.get(artifact.id), artifact)) continue;
      append({
        category: "orchestration", action: "artifact", outcome: "info",
        orchestrationId: artifact.orchestrationId, taskId: artifact.producerTaskId,
        executionId: null, agentId: null, durationMs: null,
        data: {
          id: artifact.id,
          kind: artifact.kind,
          name: artifact.name,
          version: artifact.version,
          payload: contentFingerprint(artifact.payload),
        },
      });
    }

    const oldMaps = new Set(previous.applicationMaps.map((map) => `${map.orchestrationId}:${map.version}`));
    for (const map of next.applicationMaps) {
      if (oldMaps.has(`${map.orchestrationId}:${map.version}`)) continue;
      append({
        category: "orchestration", action: "application-map", outcome: "info",
        orchestrationId: map.orchestrationId, taskId: null, executionId: null,
        agentId: null, durationMs: null,
        data: {
          version: map.version,
          repositoryHash: map.repositoryHash,
          fileCount: map.fileCount,
          summary: map.summary,
        },
      });
    }

    const oldPacketKeys = new Set(previous.contextPackets.map((packet) =>
      `${packet.taskId}:${packet.applicationMapVersion}:${packet.contractVersion}:${packet.estimatedTokens}`
    ));
    const taskIndex = byId(next.tasks);
    for (const packet of next.contextPackets) {
      const key = `${packet.taskId}:${packet.applicationMapVersion}:${packet.contractVersion}:${packet.estimatedTokens}`;
      if (oldPacketKeys.has(key)) continue;
      append({
        category: "orchestration", action: "context-packet", outcome: "info",
        orchestrationId: taskIndex.get(packet.taskId)?.orchestrationId ?? null,
        taskId: packet.taskId, executionId: null, agentId: null, durationMs: null,
        data: {
          applicationMapVersion: packet.applicationMapVersion,
          contractVersion: packet.contractVersion,
          sourceFiles: packet.sourceFiles,
          relevantInterfaces: packet.relevantInterfaces,
          artifactVersions: packet.artifactVersions,
          estimatedTokens: packet.estimatedTokens,
        },
      });
    }

    const oldCleanup = new Map(previous.cleanup.map((item) => [item.orchestrationId, item]));
    for (const cleanup of next.cleanup) {
      if (!changed(oldCleanup.get(cleanup.orchestrationId), cleanup)) continue;
      append({
        category: "orchestration", action: "cleanup", outcome: cleanup.status === "failed" ? "failed" : "info",
        orchestrationId: cleanup.orchestrationId, taskId: null, executionId: null,
        agentId: null, durationMs: null, data: { ...cleanup },
      });
    }
  };
}

export class AuditedAgentRunner implements AgentRunner {
  constructor(
    private readonly runner: AgentRunner,
    private readonly audit: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const started = this.clock();
    const prompt = contentFingerprint(request.prompt);
    await this.audit.write({
      category: "model", action: "execution", outcome: "started",
      orchestrationId: request.orchestrationId ?? null,
      taskId: request.taskId ?? null,
      executionId: request.executionId,
      agentId: request.agentId,
      durationMs: null,
      data: {
        role: request.role ?? "direct",
        modelId: request.modelId ?? null,
        sandboxMode: request.sandboxMode ?? null,
        runtimeProfile: request.runtimeProfile ?? "default",
        resumedThread: Boolean(request.threadId),
        promptCharacters: prompt.characters,
        promptSha256: prompt.sha256,
        limits: {
          maxArkApiTurns: request.maxArkApiTurns ?? null,
          maxInputTokens: request.maxInputTokens ?? null,
          maxToolCalls: request.maxToolCalls ?? null,
          timeoutMs: request.timeoutMs ?? null,
        },
      },
    });
    try {
      const result = await this.runner.run(request);
      const output = contentFingerprint(result.output);
      await this.audit.write({
        category: "model", action: "execution", outcome: "completed",
        orchestrationId: request.orchestrationId ?? null,
        taskId: request.taskId ?? null,
        executionId: request.executionId,
        agentId: request.agentId,
        durationMs: this.clock() - started,
        data: {
          role: request.role ?? "direct",
          requestedModelId: request.modelId ?? null,
          actualModelId: result.modelId ?? null,
          modelFallback: result.modelFallback ?? false,
          outputCharacters: output.characters,
          outputSha256: output.sha256,
          threadId: result.threadId,
          usage: result.usage,
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.audit.write({
        category: "model", action: "execution",
        outcome: /cancel/i.test(message) ? "cancelled" : "failed",
        orchestrationId: request.orchestrationId ?? null,
        taskId: request.taskId ?? null,
        executionId: request.executionId,
        agentId: request.agentId,
        durationMs: this.clock() - started,
        data: {
          role: request.role ?? "direct",
          modelId: request.modelId ?? null,
          errorName: error instanceof Error ? error.name : "UnknownError",
          error: redactString(message, 8_000),
        },
      });
      throw error;
    }
  }

  async cancel(executionId: string): Promise<boolean> {
    const cancelled = await this.runner.cancel(executionId);
    await this.audit.write({
      category: "model", action: "cancel-request", outcome: cancelled ? "completed" : "info",
      orchestrationId: null, taskId: null, executionId, agentId: null, durationMs: null,
      data: { activeExecutionCancelled: cancelled },
    });
    return cancelled;
  }

  isAvailable(): Promise<boolean> {
    return this.runner.isAvailable();
  }
}
