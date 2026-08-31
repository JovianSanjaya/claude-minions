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
import { parseStructured, repairPrompt, StructuredOutputError } from "./structured-output.js";

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
  return /stream disconnected|error sending request|connection (?:reset|closed|refused)|socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|network error|temporar(?:y|ily)|overload|service unavailable|gateway timeout|\b408\b|\b409\b|\b429\b|too many requests|rate limit|\b5\d\d\b|timed? out|timeout/i.test(message);
}

async function waitForTransportRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new RunCancelledError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer.unref();
  });
}

export class RoleExecutor {
  private readonly activeByOrchestration = new Map<string, Set<string>>();
  constructor(
    private readonly runner: AgentRunner,
    private readonly sink: OrchestrationSink,
    private readonly models: RoleModelConfiguration,
    private readonly runtimeHomeRoot: string,
    private readonly newId: () => string = randomUUID,
    private readonly modelCallTimeoutMs: number = 600_000,
    private readonly maxTransportRetries: number = 3,
  ) {}

  async text(input: RoleCallInput): Promise<RoleCallResult> {
    const result = await this.call(input, input.prompt);
    return { ...result, value: result.rawOutput };
  }

  async structured<T>(
    input: RoleCallInput,
    schema: z.ZodType<T>,
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
      const repair = await this.call(
        input,
        `${repairPrompt(error, jsonSchema)}\nInvalid output to repair:\n${first.rawOutput.slice(0, 8_000)}`,
      );
      try {
        return { ...repair, value: parseStructured(schema, repair.rawOutput) };
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
    const executions = [...(this.activeByOrchestration.get(orchestrationId) ?? [])];
    const results = await Promise.all(executions.map((id) => this.runner.cancel(id)));
    return results.some(Boolean);
  }

  private async call(input: RoleCallInput, prompt: string): Promise<Omit<RoleCallResult, "value">> {
    let accumulatedUsage = zeroUsage();
    let retryThreadId = input.threadId ?? null;
    const maximumAttempts = Math.max(1, Math.floor(this.maxTransportRetries) + 1);
    for (let transportAttempt = 1; transportAttempt <= maximumAttempts; transportAttempt += 1) {
      try {
        const result = await this.callOnce(
          { ...input, threadId: retryThreadId },
          prompt,
          transportAttempt,
          maximumAttempts,
        );
        return { ...result, usage: addUsage(accumulatedUsage, result.usage) };
      } catch (error) {
        const partial = error instanceof RunnerExecutionError || error instanceof RunCancelledError
          ? partialUsageOf(error)
          : zeroUsage();
        accumulatedUsage = addUsage(accumulatedUsage, partial);
        if (error instanceof RunnerExecutionError && error.partial.threadId) {
          retryThreadId = error.partial.threadId;
        }
        const canRetry = transportAttempt < maximumAttempts &&
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
        const retryDelayMs = Math.min(8_000, 500 * (2 ** (transportAttempt - 1)));
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
            resumesThread: Boolean(retryThreadId),
            partialArkApiTurns: partial.arkApiTurns ?? 0,
            partialInputTokens: partial.inputTokens,
          },
        });
        await waitForTransportRetry(retryDelayMs, input.signal);
      }
    }
    throw new Error("Model transport retry loop exited unexpectedly");
  }

  private async callOnce(
    input: RoleCallInput,
    prompt: string,
    transportAttempt: number,
    maximumTransportAttempts: number,
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
