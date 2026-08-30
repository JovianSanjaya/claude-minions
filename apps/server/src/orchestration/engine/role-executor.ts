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
  signal: AbortSignal;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

export interface RoleCallResult<T = string> {
  value: T;
  rawOutput: string;
  executionId: string;
  requestedModelId: string;
  actualModelId: string;
  modelFallback: boolean;
  usage: TokenUsage;
}

const usageOf = (result: RunnerResult): TokenUsage => ({
  inputTokens: result.usage?.inputTokens ?? 0,
  cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
  outputTokens: result.usage?.outputTokens ?? 0,
});

export class RoleExecutor {
  private readonly activeByOrchestration = new Map<string, Set<string>>();
  constructor(
    private readonly runner: AgentRunner,
    private readonly sink: OrchestrationSink,
    private readonly models: RoleModelConfiguration,
    private readonly runtimeHomeRoot: string,
    private readonly newId: () => string = randomUUID,
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
        threadId: null,
        orchestrationId: input.orchestrationId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        role: input.role,
        modelId: requestedModelId,
        runtimeHomePath,
        sandboxMode: input.sandboxMode,
      });
      await this.sink.commitModelUsage(reservation.reservationId, usageOf(result));
    } catch (error) {
      await this.sink.commitModelUsage(reservation.reservationId, {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
      throw error;
    } finally {
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
      },
    });
    return {
      rawOutput: result.output,
      executionId,
      requestedModelId,
      actualModelId,
      modelFallback,
      usage: usageOf(result),
    };
  }
}
