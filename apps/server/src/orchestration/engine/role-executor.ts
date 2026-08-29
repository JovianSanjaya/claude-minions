import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type {
  ModelRole,
  OrchestrationSink,
  TokenUsage,
} from "../contracts.js";
import type { AgentRunner, RunnerResult } from "../../types.js";
import { parseStructuredOutput, StructuredOutputError } from "./structured-output.js";

const SECRET_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._~-]{8,}|(?:api[_-]?key|password|token)\s*[:=]\s*[^\s,;]+)/gi;

function safe(value: string, limit = 1_000): string {
  return value.replace(SECRET_VALUE, "[REDACTED]").slice(0, limit);
}

function usageOf(result: RunnerResult): TokenUsage {
  return {
    inputTokens: result.usage?.inputTokens ?? 0,
    cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

export class BudgetDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BudgetDeniedError";
  }
}

export interface RoleModels {
  planner: string;
  worker: string;
  verifier: string;
  integrator: string;
}

export interface RoleExecutorOptions {
  runner: AgentRunner;
  models: RoleModels;
  baseModelId: string;
  modelOverrideSupported: boolean;
  runtimeHomeRoot: string;
  idProvider?: () => string;
}

export interface RoleCallInput {
  orchestrationId: string;
  taskId: string | null;
  agentId: string;
  role: ModelRole;
  prompt: string;
  workspacePath: string;
  sandboxMode: "read-only" | "workspace-write";
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  sink: OrchestrationSink;
  signal: AbortSignal;
}

export interface RoleCallResult<T> {
  value: T;
  executionId: string;
  modelId: string;
  modelFallback: boolean;
  usage: TokenUsage;
}

export class RoleExecutor {
  private readonly activeByOrchestration = new Map<string, Set<string>>();
  private readonly idProvider: () => string;

  constructor(private readonly options: RoleExecutorOptions) {
    this.idProvider = options.idProvider ?? randomUUID;
  }

  async callText(input: RoleCallInput): Promise<RoleCallResult<string>> {
    const result = await this.runOnce(input, input.prompt, "call");
    return { ...result, value: result.result.output };
  }

  async callStructured<T>(
    input: RoleCallInput,
    schema: z.ZodType<T>,
    schemaDescription: string,
  ): Promise<RoleCallResult<T>> {
    const first = await this.runOnce(input, input.prompt, "call");
    try {
      return {
        executionId: first.executionId,
        modelId: first.modelId,
        modelFallback: first.modelFallback,
        usage: first.usage,
        value: parseStructuredOutput(schema, first.result.output),
      };
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      await input.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        executionId: first.executionId,
        type: "model.structured-output-repair",
        actorRole: input.role,
        modelId: first.modelId,
        summary: "Structured response was invalid; one bounded repair was requested.",
        metadata: { error: safe(error.message, 500) },
      });
      const repairPrompt = [
        "Return only corrected JSON matching this schema description:",
        schemaDescription.slice(0, 4_000),
        "Invalid response excerpt:",
        safe(error.responseExcerpt, 8_000),
        "Do not include analysis, Markdown fences, or extra fields.",
      ].join("\n\n");
      const repaired = await this.runOnce(input, repairPrompt, "repair");
      return {
        executionId: repaired.executionId,
        modelId: repaired.modelId,
        modelFallback: repaired.modelFallback,
        usage: {
          inputTokens: first.usage.inputTokens + repaired.usage.inputTokens,
          cachedInputTokens:
            first.usage.cachedInputTokens + repaired.usage.cachedInputTokens,
          outputTokens: first.usage.outputTokens + repaired.usage.outputTokens,
        },
        value: parseStructuredOutput(schema, repaired.result.output),
      };
    }
  }

  async cancel(orchestrationId: string): Promise<boolean> {
    const executions = [...(this.activeByOrchestration.get(orchestrationId) ?? [])];
    const results = await Promise.all(executions.map((executionId) => this.options.runner.cancel(executionId)));
    return results.some(Boolean);
  }

  private async runOnce(
    input: RoleCallInput,
    prompt: string,
    phase: "call" | "repair",
  ): Promise<{
    result: RunnerResult;
    executionId: string;
    modelId: string;
    modelFallback: boolean;
    usage: TokenUsage;
  }> {
    if (input.signal.aborted) throw new DOMException("Orchestration cancelled", "AbortError");
    const requestedModel = this.options.models[input.role];
    const executionId = `${input.orchestrationId}-${input.role}-${this.idProvider()}`;
    const reservation = await input.sink.reserveModelCall({
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      executionId,
      role: input.role,
      modelId: requestedModel,
      estimatedInputTokens: input.estimatedInputTokens,
      estimatedOutputTokens: input.estimatedOutputTokens,
    });
    if (!reservation.allowed) throw new BudgetDeniedError(reservation.reason);

    const runtimeHomePath = path.join(
      path.resolve(this.options.runtimeHomeRoot),
      input.role,
      executionId.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    );
    await mkdir(runtimeHomePath, { recursive: true, mode: 0o700 });
    const active = this.activeByOrchestration.get(input.orchestrationId) ?? new Set<string>();
    active.add(executionId);
    this.activeByOrchestration.set(input.orchestrationId, active);
    const cancel = () => void this.options.runner.cancel(executionId);
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.options.runner.run({
        executionId,
        agentId: input.agentId,
        orchestrationId: input.orchestrationId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        role: input.role,
        workspacePath: input.workspacePath,
        prompt,
        threadId: null,
        ...(this.options.modelOverrideSupported ? { modelId: requestedModel } : {}),
        runtimeHomePath,
        sandboxMode: input.sandboxMode,
      });
      const usage = usageOf(result);
      await input.sink.commitModelUsage(reservation.reservationId, usage);
      const actualModelId =
        result.modelId ??
        (this.options.modelOverrideSupported ? requestedModel : this.options.baseModelId);
      const modelFallback =
        result.modelFallback ??
        (actualModelId !== requestedModel || !this.options.modelOverrideSupported);
      await input.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        executionId,
        type: phase === "repair" ? "model.repair-completed" : "model.call-completed",
        actorRole: input.role,
        modelId: actualModelId,
        summary: `${input.role} model call completed${modelFallback ? " using the configured fallback" : ""}.`,
        metadata: {
          requestedModel,
          actualModel: actualModelId,
          fallback: modelFallback,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        },
      });
      return { result, executionId, modelId: actualModelId, modelFallback, usage };
    } finally {
      input.signal.removeEventListener("abort", cancel);
      active.delete(executionId);
      if (active.size === 0) this.activeByOrchestration.delete(input.orchestrationId);
    }
  }
}
