import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ModelRole,
  OrchestrationSink,
  TokenUsage,
} from "../contracts.js";
import type { AgentRunner, RunnerResult } from "../../types.js";
import { RunCancelledError, RunnerExecutionError } from "../../errors.js";
import {
  extractJson,
  parseStructured,
  repairPrompt,
  StructuredOutputError,
} from "./structured-output.js";

export interface RoleModelConfiguration {
  planner: string;
  worker: string;
  verifier: string;
  integrator: string;
}

export interface RoleCallInput {
  orchestrationId: string;
  agentId: string;
  taskId: string | null;
  role: ModelRole;
  workspacePath: string;
  prompt: string;
  sandboxMode: "read-only" | "workspace-write";
  allowedWritePaths?: string[];
  runtimeProfile?: "default" | "verification";
  signal: AbortSignal;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  maxArkApiTurns?: number | undefined;
  maxInputTokens?: number | undefined;
  threadId?: string | null;
}

export interface RoleCallResult<T = string> {
  value: T;
  rawOutput: string;
  executionId: string;
  requestedModelId: string;
  actualModelId: string;
  modelFallback: boolean;
  usage: TokenUsage;
  threadId: string | null;
}

export interface StructuredRepairOptions {
  instructions?: string[];
  merge?: (
    original: unknown,
    repaired: unknown,
    issues: string[],
  ) => unknown;
}

export interface ModelTransportRetryPolicy {
  /** Retries after the first attempt. Null keeps retrying until cancellation. */
  maxRetries: number | null;
  pauseAfterMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

const DEFAULT_TRANSPORT_RETRY_POLICY: ModelTransportRetryPolicy = {
  maxRetries: 3,
  pauseAfterMs: 300_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

function normalizedRetryPolicy(
  value: number | Partial<ModelTransportRetryPolicy> | undefined,
): ModelTransportRetryPolicy {
  if (typeof value === "number") {
    return { ...DEFAULT_TRANSPORT_RETRY_POLICY, maxRetries: Math.max(0, Math.floor(value)) };
  }
  const configured = { ...DEFAULT_TRANSPORT_RETRY_POLICY, ...value };
  return {
    maxRetries: configured.maxRetries === null
      ? null
      : Math.max(0, Math.floor(configured.maxRetries)),
    pauseAfterMs: Math.max(0, Math.floor(configured.pauseAfterMs)),
    baseDelayMs: Math.max(1, Math.floor(configured.baseDelayMs)),
    maxDelayMs: Math.max(1, Math.floor(configured.maxDelayMs)),
    jitterRatio: Math.min(1, Math.max(0, configured.jitterRatio)),
  };
}

const usageOf = (result: RunnerResult): TokenUsage => ({
  inputTokens: result.usage?.inputTokens ?? 0,
  cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
  outputTokens: result.usage?.outputTokens ?? 0,
  arkApiTurns: result.usage?.arkApiTurns ?? 0,
  toolCalls: result.usage?.toolCalls ?? 0,
  streamRetries: result.usage?.streamRetries ?? 0,
  peakContextTokens: result.usage?.peakContextTokens ?? 0,
});

const partialUsageOf = (
  error: RunnerExecutionError | RunCancelledError,
): TokenUsage => ({
  inputTokens: error.partial?.usage?.inputTokens ?? 0,
  cachedInputTokens: error.partial?.usage?.cachedInputTokens ?? 0,
  outputTokens: error.partial?.usage?.outputTokens ?? 0,
  arkApiTurns: error.partial?.usage?.arkApiTurns ?? 0,
  toolCalls: error.partial?.usage?.toolCalls ?? 0,
  streamRetries: error.partial?.usage?.streamRetries ?? 0,
  peakContextTokens: error.partial?.usage?.peakContextTokens ?? 0,
});

const addUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  arkApiTurns: (left.arkApiTurns ?? 0) + (right.arkApiTurns ?? 0),
  toolCalls: (left.toolCalls ?? 0) + (right.toolCalls ?? 0),
  streamRetries: (left.streamRetries ?? 0) + (right.streamRetries ?? 0),
  peakContextTokens: Math.max(left.peakContextTokens ?? 0, right.peakContextTokens ?? 0),
});

const zeroUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  arkApiTurns: 0,
  toolCalls: 0,
  streamRetries: 0,
  peakContextTokens: 0,
});

export function isRetryableRoleTransportFailure(error: unknown): boolean {
  if (error instanceof RunCancelledError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/budget denied|input-token limit|ark-turn limit|scope violation|permission denied|unauthori[sz]ed|forbidden/i.test(message)) {
    return false;
  }
  return /stream disconnected|error sending request|fetch failed|connect error|connection (?:reset|closed|refused)|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|UND_ERR|TLS|certificate|HTTP\/2|incomplete message|network error|temporar(?:y|ily)|overload|service unavailable|gateway timeout|\b408\b|\b409\b|\b429\b|too many requests|rate limit|\b5\d\d\b|timed? out|timeout/i.test(message);
}

export class RoleExecutor {
  private readonly activeByOrchestration = new Map<string, Set<string>>();
  private readonly retryWaiters = new Map<string, Set<() => void>>();
  private readonly retryPolicy: ModelTransportRetryPolicy;

  constructor(
    private readonly runner: AgentRunner,
    private readonly sink: OrchestrationSink,
    private readonly models: RoleModelConfiguration,
    private readonly runtimeHomeRoot: string,
    private readonly newId: () => string = randomUUID,
    private readonly modelCallTimeoutMs: number = 1_800_000,
    retryPolicy: number | Partial<ModelTransportRetryPolicy> = DEFAULT_TRANSPORT_RETRY_POLICY,
  ) {
    this.retryPolicy = normalizedRetryPolicy(retryPolicy);
  }

  async text(input: RoleCallInput): Promise<RoleCallResult> {
    const result = await this.call(input, input.prompt);
    return { ...result, value: result.rawOutput };
  }

  async structured<T>(
    input: RoleCallInput,
    schema: z.ZodType<T>,
    repairOptions: StructuredRepairOptions = {},
  ): Promise<RoleCallResult<T>> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const responseContract = [
      "RESPONSE CONTRACT:",
      "Return exactly one JSON value. Do not include prose or markdown fences.",
      `Required JSON Schema: ${JSON.stringify(jsonSchema)}`,
    ].join("\n");
    const first = await this.call(input, `${input.prompt}\n\n${responseContract}`);
    try {
      return { ...first, value: parseStructured(schema, first.rawOutput) };
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      const resumesFirstExecution = Boolean(first.threadId);
      const repair = await this.call(
        first.threadId ? { ...input, threadId: first.threadId } : input,
        resumesFirstExecution
          ? [
              "Correct your immediately preceding JSON response in this same thread.",
              "Return the complete corrected JSON value only, with no prose or markdown fences.",
              `Validation problems: ${error.issues.join("; ")}`,
              ...(repairOptions.instructions ?? []),
              "Reuse every valid field from your preceding response; change only what these validation problems require.",
            ].join("\n")
          : [
              repairPrompt(error, jsonSchema),
              ...(repairOptions.instructions ?? []),
              "Invalid output to repair:",
              first.rawOutput,
            ].join("\n"),
      );
      try {
        if (!repairOptions.merge) {
          return { ...repair, value: parseStructured(schema, repair.rawOutput) };
        }
        const merged = repairOptions.merge(
          extractJson(first.rawOutput),
          extractJson(repair.rawOutput),
          error.issues,
        );
        const mergedOutput = JSON.stringify(merged);
        return {
          ...repair,
          rawOutput: mergedOutput,
          value: parseStructured(schema, mergedOutput),
        };
      } catch (repairError) {
        if (!(repairError instanceof StructuredOutputError)) throw repairError;
        throw new StructuredOutputError(
          `Model response remained invalid after one repair: ${repairError.issues.slice(0, 6).join("; ")}`,
          repairError.issues,
        );
      }
    }
  }

  async cancelOrchestration(orchestrationId: string): Promise<boolean> {
    this.retryNow(orchestrationId);
    const executions = [...(this.activeByOrchestration.get(orchestrationId) ?? [])];
    const results = await Promise.all(executions.map((id) => this.runner.cancel(id)));
    return results.some(Boolean);
  }

  retryNow(orchestrationId: string): boolean {
    const waiters = [...(this.retryWaiters.get(orchestrationId) ?? [])];
    for (const wake of waiters) wake();
    return waiters.length > 0;
  }

  private async call(input: RoleCallInput, prompt: string): Promise<Omit<RoleCallResult, "value">> {
    let accumulatedUsage = zeroUsage();
    let retryThreadId = input.threadId ?? null;
    const retryStartedAt = Date.now();
    const maximumAttempts = this.retryPolicy.maxRetries === null
      ? null
      : this.retryPolicy.maxRetries + 1;
    const connectionKey = `${input.role}:${input.taskId ?? "global"}`;
    let connectionPaused = false;
    for (let transportAttempt = 1; ; transportAttempt += 1) {
      try {
        const result = await this.callOnce(
          { ...input, threadId: retryThreadId },
          prompt,
          transportAttempt,
          maximumAttempts,
        );
        if (connectionPaused) {
          await this.sink.recordEvent({
            orchestrationId: input.orchestrationId,
            taskId: input.taskId,
            executionId: result.executionId,
            type: "role-call-connection-restored",
            actorRole: input.role,
            modelId: result.actualModelId,
            summary: `${input.role} model connection was restored; execution resumed automatically`,
            metadata: {
              recoveredAttempt: transportAttempt,
              disconnectedForMs: Date.now() - retryStartedAt,
              resumedThread: Boolean(result.threadId ?? retryThreadId),
              connectionKey,
            },
          });
        }
        return { ...result, usage: addUsage(accumulatedUsage, result.usage) };
      } catch (error) {
        const partial = error instanceof RunnerExecutionError || error instanceof RunCancelledError
          ? partialUsageOf(error)
          : zeroUsage();
        accumulatedUsage = addUsage(accumulatedUsage, partial);
        if (error instanceof RunnerExecutionError && error.partial.threadId) {
          retryThreadId = error.partial.threadId;
        }
        const canRetry = (maximumAttempts === null || transportAttempt < maximumAttempts) &&
          !input.signal.aborted &&
          isRetryableRoleTransportFailure(error);
        if (!canRetry) {
          if (error instanceof RunnerExecutionError) {
            throw new RunnerExecutionError(error.message, {
              ...error.partial,
              threadId: error.partial.threadId ?? retryThreadId,
              usage: accumulatedUsage,
            });
          }
          throw error;
        }
        const rawDelayMs = Math.min(
          this.retryPolicy.maxDelayMs,
          this.retryPolicy.baseDelayMs * (2 ** Math.min(transportAttempt - 1, 30)),
        );
        const jitter = rawDelayMs * this.retryPolicy.jitterRatio * ((Math.random() * 2) - 1);
        const retryDelayMs = Math.min(
          this.retryPolicy.maxDelayMs,
          Math.max(1, Math.round(rawDelayMs + jitter)),
        );
        const elapsedMs = Date.now() - retryStartedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const diagnostics = await this.diagnoseTransport(
          transportAttempt === 1 || (!connectionPaused && elapsedMs >= this.retryPolicy.pauseAfterMs),
        );
        if (!connectionPaused && elapsedMs >= this.retryPolicy.pauseAfterMs) {
          connectionPaused = true;
          await this.sink.recordEvent({
            orchestrationId: input.orchestrationId,
            taskId: input.taskId,
            executionId: null,
            type: "role-call-connection-paused",
            actorRole: input.role,
            modelId: this.models[input.role],
            summary: `${input.role} model connection remains unavailable; execution is preserved and retrying`,
            metadata: {
              failedAttempt: transportAttempt,
              elapsedMs,
              retryDelayMs,
              nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
              resumesThread: Boolean(retryThreadId),
              error: errorMessage,
              connectionKey,
              ...diagnostics,
            },
          });
        }
        await this.sink.recordEvent({
          orchestrationId: input.orchestrationId,
          taskId: input.taskId,
          executionId: null,
          type: "role-call-transport-retry",
          actorRole: input.role,
          modelId: this.models[input.role],
          summary: `${input.role} model connection was interrupted; reconnecting automatically`,
          metadata: {
            failedAttempt: transportAttempt,
            nextAttempt: transportAttempt + 1,
            maximumAttempts,
            retryDelayMs,
            nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
            resumesThread: Boolean(retryThreadId),
            partialArkApiTurns: partial.arkApiTurns ?? 0,
            partialInputTokens: partial.inputTokens,
            error: errorMessage,
            ...diagnostics,
          },
        });
        await this.waitForTransportRetry(input.orchestrationId, retryDelayMs, input.signal);
      }
    }
  }

  private async diagnoseTransport(
    enabled: boolean,
  ): Promise<Record<string, string | number | boolean | null>> {
    if (!enabled || !this.runner.diagnoseTransport) return {};
    try {
      const result = await this.runner.diagnoseTransport();
      return {
        diagnosticCheckedAt: result.checkedAt,
        diagnosticTarget: result.target,
        diagnosticDnsAddress: result.dnsAddress,
        diagnosticHttpStatus: result.httpStatus,
        diagnosticElapsedMs: result.elapsedMs,
        diagnosticErrorCode: result.errorCode,
        diagnosticErrorMessage: result.errorMessage,
      };
    } catch (error) {
      return {
        diagnosticError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async waitForTransportRetry(
    orchestrationId: string,
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new RunCancelledError();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiters = this.retryWaiters.get(orchestrationId) ?? new Set<() => void>();
      this.retryWaiters.set(orchestrationId, waiters);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (!waiters.size) this.retryWaiters.delete(orchestrationId);
      };
      const complete = (operation: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const wake = () => complete(resolve);
      const onAbort = () => complete(() => reject(new RunCancelledError()));
      const timer = setTimeout(wake, milliseconds);
      waiters.add(wake);
      signal.addEventListener("abort", onAbort, { once: true });
      timer.unref();
    });
  }

  private async callOnce(
    input: RoleCallInput,
    prompt: string,
    transportAttempt: number,
    maximumTransportAttempts: number | null,
  ): Promise<Omit<RoleCallResult, "value">> {
    if (input.signal.aborted) throw new Error("Orchestration cancelled");
    const executionId = this.newId();
    const requestedModelId = this.models[input.role];
    const reservation = await this.sink.reserveModelCall({
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      executionId,
      role: input.role,
      modelId: requestedModelId,
      estimatedInputTokens:
        input.estimatedInputTokens ?? Math.max(1, Math.ceil(prompt.length / 4)),
      estimatedOutputTokens: input.estimatedOutputTokens ?? 2_000,
    });
    if (!reservation.allowed) throw new Error(`Budget denied: ${reservation.reason}`);
    const active = this.activeByOrchestration.get(input.orchestrationId) ?? new Set<string>();
    active.add(executionId);
    this.activeByOrchestration.set(input.orchestrationId, active);
    const startedAt = Date.now();
    await this.sink.recordEvent({
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      executionId,
      type: "role-call-started",
      actorRole: input.role,
      modelId: requestedModelId,
      summary: `${input.role} model call started`,
      metadata: {
        timeoutMs: this.modelCallTimeoutMs,
        transportAttempt,
        maximumTransportAttempts,
        estimatedInputTokens: input.estimatedInputTokens ?? Math.max(1, Math.ceil(prompt.length / 4)),
        estimatedOutputTokens: input.estimatedOutputTokens ?? 2_000,
      },
    });
    const heartbeat = setInterval(() => {
      void this.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        executionId,
        type: "role-call-heartbeat",
        actorRole: input.role,
        modelId: requestedModelId,
        summary: `${input.role} model call is still running`,
        metadata: {
          elapsedMs: Date.now() - startedAt,
          timeoutMs: this.modelCallTimeoutMs,
        },
      }).catch(() => undefined);
    }, 15_000);
    heartbeat.unref();
    const runtimeHomePath = path.join(
      this.runtimeHomeRoot,
      input.orchestrationId.replace(/[^A-Za-z0-9_.-]/g, "-"),
      input.role,
      input.taskId?.replace(/[^A-Za-z0-9_.-]/g, "-") ?? "global",
    );
    await mkdir(runtimeHomePath, { recursive: true, mode: 0o700 });
    const onAbort = () => void this.runner.cancel(executionId);
    input.signal.addEventListener("abort", onAbort, { once: true });
    let result: RunnerResult;
    try {
      result = await this.runner.run({
        executionId,
        agentId: input.agentId,
        workspacePath: input.workspacePath,
        prompt,
        threadId: input.threadId ?? null,
        orchestrationId: input.orchestrationId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        role: input.role,
        modelId: requestedModelId,
        runtimeHomePath,
        sandboxMode: input.sandboxMode,
        allowedWritePaths: input.allowedWritePaths,
        runtimeProfile: input.runtimeProfile ?? "default",
        maxArkApiTurns: input.maxArkApiTurns,
        maxInputTokens: input.maxInputTokens,
      });
      await this.sink.commitModelUsage(reservation.reservationId, usageOf(result));
    } catch (error) {
      const partialUsage: TokenUsage = error instanceof RunnerExecutionError || error instanceof RunCancelledError
        ? partialUsageOf(error)
        : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      await this.sink.commitModelUsage(reservation.reservationId, partialUsage);
      await this.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        executionId,
        type: "role-call-failed",
        actorRole: input.role,
        modelId: requestedModelId,
        summary: `${input.role} model call stopped with an error`,
        metadata: {
          arkApiTurns: partialUsage.arkApiTurns ?? 0,
          toolCalls: partialUsage.toolCalls ?? 0,
          partialInputTokens: partialUsage.inputTokens,
          partialOutputTokens: partialUsage.outputTokens,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      input.signal.removeEventListener("abort", onAbort);
      active.delete(executionId);
      if (!active.size) this.activeByOrchestration.delete(input.orchestrationId);
    }
    const actualModelId = result.modelId ?? requestedModelId;
    const modelFallback = result.modelFallback ?? actualModelId !== requestedModelId;
    await this.sink.recordEvent({
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      executionId,
      type: "role-call-completed",
      actorRole: input.role,
      modelId: actualModelId,
      summary: `${input.role} model call completed`,
      metadata: {
        requestedModelId,
        actualModelId,
        modelFallback,
        sandboxMode: input.sandboxMode,
        runtimeProfile: input.runtimeProfile ?? "default",
      },
    });
    return {
      rawOutput: result.output,
      executionId,
      requestedModelId,
      actualModelId,
      modelFallback,
      usage: usageOf(result),
      threadId: result.threadId,
    };
  }
}
