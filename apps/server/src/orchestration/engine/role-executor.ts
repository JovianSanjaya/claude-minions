import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type {
  AgentRunner,
  ExecutionSandboxMode,
  RunUsage,
  RunnerResult,
} from "../../types.js";
import type { ModelRole, OrchestrationSink, TokenUsage } from "../contracts.js";
import { buildRepairPrompt, parseStructured } from "./structured-output.js";

/**
 * Trusted model IDs by logical role. `fallbackModelId` is the single
 * configured Ark model that every role uses when no per-role override is
 * configured, or when the installed Codex CLI cannot accept a model argument.
 */
export interface ModelRoleConfig {
  fallbackModelId: string;
  planner?: string | undefined;
  worker?: string | undefined;
  verifier?: string | undefined;
  integrator?: string | undefined;
}

/** Truthful capability probe for the installed Runtime. */
export interface ModelCapabilityProbe {
  supportsModelOverride(): Promise<boolean>;
}

export interface ResolvedRoleModel {
  modelId: string;
  /** True when the role could not use its own configured model. */
  fallback: boolean;
  fallbackReason: string | null;
}

export interface RoleCallRequest {
  role: ModelRole;
  taskId: string | null;
  prompt: string;
  workspacePath: string;
  sandboxMode: ExecutionSandboxMode;
  threadId?: string | null | undefined;
  runtimeHomePath?: string | undefined;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Safe, human-readable summary persisted as evidence. */
  summary: string;
  metadata?: Record<string, string | number | boolean | null> | undefined;
}

export interface RoleCallSuccess<T> {
  kind: "ok";
  value: T;
  raw: string;
  usage: TokenUsage;
  executionId: string;
  modelId: string;
  modelFallback: boolean;
  threadId: string | null;
  modelCalls: number;
}

export type RoleCallResult<T> =
  | RoleCallSuccess<T>
  | { kind: "budget-denied"; reason: string; usage: TokenUsage; modelCalls: number }
  | { kind: "invalid-output"; error: string; usage: TokenUsage; modelCalls: number }
  | { kind: "cancelled"; reason: string; usage: TokenUsage; modelCalls: number }
  | { kind: "error"; error: string; usage: TokenUsage; modelCalls: number };

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
});

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

export function toTokenUsage(usage: RunUsage | null): TokenUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

export interface RoleExecutorOptions {
  orchestrationId: string;
  agentId: string;
  runner: AgentRunner;
  sink: OrchestrationSink;
  models: ModelRoleConfig;
  probe: ModelCapabilityProbe;
  signal: AbortSignal;
  /** Trusted per-role Codex/Runtime state directories. */
  runtimeHomes?: Partial<Record<ModelRole, string>> | undefined;
  /** Notified while a child execution is in flight, for cancellation. */
  onExecutionStart?: ((executionId: string) => void) | undefined;
  onExecutionEnd?: ((executionId: string) => void) | undefined;
  idFactory?: (() => string) | undefined;
}

/**
 * Runs one logical role call against the real `AgentRunner`.
 *
 * Every call: reserves budget through the sink, uses a stable execution ID and
 * the orchestration cancellation signal, sends only role-specific context,
 * commits actual usage, and records safe role/model evidence. Hidden reasoning
 * is never persisted - only the final message and derived structured data.
 */
export class RoleExecutor {
  private resolvedSupport: boolean | null = null;

  constructor(private readonly options: RoleExecutorOptions) {}

  async resolveModel(role: ModelRole): Promise<ResolvedRoleModel> {
    const configured = this.options.models[role];
    const fallbackModelId = this.options.models.fallbackModelId || "ark-default";
    if (this.resolvedSupport === null) {
      this.resolvedSupport = await this.options.probe.supportsModelOverride();
    }
    if (!this.resolvedSupport) {
      return {
        modelId: fallbackModelId,
        fallback: true,
        fallbackReason:
          "The installed Codex Runtime does not accept a model override, so this role uses the configured Ark model",
      };
    }
    if (!configured || configured === fallbackModelId) {
      return {
        modelId: fallbackModelId,
        fallback: !configured,
        fallbackReason: configured
          ? null
          : "No model is configured for this role, so it uses the configured Ark model",
      };
    }
    return { modelId: configured, fallback: false, fallbackReason: null };
  }

  /** Runs a role call whose response is free text. */
  async callText(request: RoleCallRequest): Promise<RoleCallResult<string>> {
    const attempt = await this.invoke(request, request.prompt);
    if (attempt.kind !== "ok") return attempt;
    return { ...attempt, value: attempt.raw };
  }

  /**
   * Runs a role call whose response must satisfy `schema`. Exactly one bounded
   * repair attempt is allowed; a second failure is reported explicitly.
   */
  async callStructured<T>(
    schema: z.ZodType<T>,
    schemaDescription: string,
    request: RoleCallRequest,
  ): Promise<RoleCallResult<T>> {
    const first = await this.invoke(request, request.prompt);
    if (first.kind !== "ok") return first;
    const parsed = parseStructured(schema, first.raw);
    if (parsed.ok) {
      return { ...first, value: parsed.value };
    }

    await this.options.sink.recordEvent({
      orchestrationId: this.options.orchestrationId,
      taskId: request.taskId,
      executionId: first.executionId,
      type: "model.output-repair",
      actorRole: request.role,
      modelId: first.modelId,
      summary: "Structured output failed validation; one repair attempt allowed",
      metadata: { failure: parsed.error.slice(0, 300), attempt: 1 },
    });

    const repair = await this.invoke(
      {
        ...request,
        summary: request.summary + " (repair)",
        threadId: first.threadId,
      },
      buildRepairPrompt(schemaDescription, parsed.error),
    );
    const usageAfterRepair = addUsage(first.usage, repair.usage);
    const callsAfterRepair = first.modelCalls + repair.modelCalls;
    if (repair.kind !== "ok") {
      if (repair.kind === "budget-denied" || repair.kind === "cancelled") {
        return { ...repair, usage: usageAfterRepair, modelCalls: callsAfterRepair };
      }
      return {
        kind: "invalid-output",
        error: parsed.error,
        usage: usageAfterRepair,
        modelCalls: callsAfterRepair,
      };
    }
    const repaired = parseStructured(schema, repair.raw);
    if (!repaired.ok) {
      await this.options.sink.recordEvent({
        orchestrationId: this.options.orchestrationId,
        taskId: request.taskId,
        executionId: repair.executionId,
        type: "model.output-invalid",
        actorRole: request.role,
        modelId: repair.modelId,
        summary: "Structured output still invalid after one repair attempt",
        metadata: { failure: repaired.error.slice(0, 300) },
      });
      return {
        kind: "invalid-output",
        error: repaired.error,
        usage: usageAfterRepair,
        modelCalls: callsAfterRepair,
      };
    }
    return {
      ...repair,
      value: repaired.value,
      usage: usageAfterRepair,
      modelCalls: callsAfterRepair,
    };
  }

  private async invoke(
    request: RoleCallRequest,
    prompt: string,
  ): Promise<RoleCallResult<string>> {
    if (this.options.signal.aborted) {
      return {
        kind: "cancelled",
        reason: "Orchestration was cancelled before the model call started",
        usage: emptyUsage(),
        modelCalls: 0,
      };
    }
    const executionId = (this.options.idFactory ?? randomUUID)();
    const model = await this.resolveModel(request.role);

    const decision = await this.options.sink.reserveModelCall({
      orchestrationId: this.options.orchestrationId,
      taskId: request.taskId,
      executionId,
      role: request.role,
      modelId: model.modelId,
      estimatedInputTokens: Math.max(0, Math.round(request.estimatedInputTokens)),
      estimatedOutputTokens: Math.max(0, Math.round(request.estimatedOutputTokens)),
    });
    if (!decision.allowed) {
      await this.options.sink.recordEvent({
        orchestrationId: this.options.orchestrationId,
        taskId: request.taskId,
        executionId,
        type: "budget.denied",
        actorRole: "control-plane",
        modelId: model.modelId,
        summary: "Budget denied a " + request.role + " call",
        metadata: { reason: decision.reason.slice(0, 300), role: request.role },
      });
      return {
        kind: "budget-denied",
        reason: decision.reason,
        usage: emptyUsage(),
        modelCalls: 0,
      };
    }

    this.options.onExecutionStart?.(executionId);
    let result: RunnerResult;
    try {
      result = await this.options.runner.run({
        agentId: this.options.agentId,
        workspacePath: request.workspacePath,
        prompt,
        threadId: request.threadId ?? null,
        executionId,
        orchestrationId: this.options.orchestrationId,
        ...(request.taskId ? { taskId: request.taskId } : {}),
        role: request.role,
        ...(model.fallback ? {} : { modelId: model.modelId }),
        ...(request.runtimeHomePath ?? this.options.runtimeHomes?.[request.role]
          ? {
              runtimeHomePath:
                request.runtimeHomePath ??
                (this.options.runtimeHomes?.[request.role] as string),
            }
          : {}),
        sandboxMode: request.sandboxMode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.sink.commitModelUsage(decision.reservationId, emptyUsage());
      await this.options.sink.recordEvent({
        orchestrationId: this.options.orchestrationId,
        taskId: request.taskId,
        executionId,
        type: "model.call-failed",
        actorRole: request.role,
        modelId: model.modelId,
        summary: request.summary + " failed",
        metadata: { error: message.slice(0, 300) },
      });
      if (this.options.signal.aborted) {
        return {
          kind: "cancelled",
          reason: "Orchestration was cancelled during a " + request.role + " call",
          usage: emptyUsage(),
          modelCalls: 1,
        };
      }
      return { kind: "error", error: message, usage: emptyUsage(), modelCalls: 1 };
    } finally {
      this.options.onExecutionEnd?.(executionId);
    }

    const usage = toTokenUsage(result.usage);
    await this.options.sink.commitModelUsage(decision.reservationId, usage);
    await this.options.sink.recordEvent({
      orchestrationId: this.options.orchestrationId,
      taskId: request.taskId,
      executionId,
      type: "model.call",
      actorRole: request.role,
      modelId: model.modelId,
      summary: request.summary,
      metadata: {
        ...(request.metadata ?? {}),
        role: request.role,
        sandboxMode: request.sandboxMode,
        modelFallback: model.fallback,
        modelFallbackReason: model.fallbackReason,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
      },
    });

    if (this.options.signal.aborted) {
      return {
        kind: "cancelled",
        reason: "Orchestration was cancelled during a " + request.role + " call",
        usage,
        modelCalls: 1,
      };
    }

    return {
      kind: "ok",
      value: result.output,
      raw: result.output,
      usage,
      executionId,
      modelId: model.modelId,
      modelFallback: model.fallback,
      threadId: result.threadId,
      modelCalls: 1,
    };
  }
}

/**
 * Adapts an `AgentRunner` that exposes `supportsModelOverride()` into a probe.
 * Runners without the method truthfully report no override support.
 */
export function runnerCapabilityProbe(runner: AgentRunner): ModelCapabilityProbe {
  const candidate = runner as AgentRunner & {
    supportsModelOverride?: () => Promise<boolean>;
  };
  return {
    async supportsModelOverride(): Promise<boolean> {
      if (typeof candidate.supportsModelOverride !== "function") return false;
      try {
        return await candidate.supportsModelOverride();
      } catch {
        return false;
      }
    },
  };
}
