import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AgentRunner } from "../../types.js";
import type { ModelRole, OrchestrationSink, TokenUsage } from "../contracts.js";
import { parseStructuredOutput } from "./structured-output.js";

export class BudgetDeniedError extends Error {
  constructor(
    public readonly role: ModelRole,
    reason: string,
  ) {
    super(`Budget denied for role "${role}": ${reason}`);
    this.name = "BudgetDeniedError";
  }
}

export class RoleExecutionCancelledError extends Error {
  constructor() {
    super("Cancelled before this model call started");
    this.name = "RoleExecutionCancelledError";
  }
}

export interface RoleExecutorDeps {
  runner: AgentRunner;
  sink: OrchestrationSink;
  /** Configured model id per logical role. Falls back to `defaultModelId` when a role has no override — the truthful single-endpoint fallback the spec requires (never fabricate multi-model behavior that isn't happening). */
  modelIds: Partial<Record<ModelRole, string>>;
  defaultModelId: string;
}

export interface RoleCallInput {
  agentId: string;
  orchestrationId: string;
  taskId: string | null;
  role: ModelRole;
  prompt: string;
  workspacePath: string;
  threadId: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  signal: AbortSignal;
  /** e.g. "read-only" for a worker preflight, before any writable execution is approved. */
  sandboxMode?: "read-only" | "workspace-write" | undefined;
}

export interface RoleCallResult {
  output: string;
  threadId: string | null;
  usage: TokenUsage;
  modelId: string;
  executionId: string;
}

function resolveModelId(deps: RoleExecutorDeps, role: ModelRole): string {
  return deps.modelIds[role] ?? deps.defaultModelId;
}

/**
 * The single choke point every model call in the engine goes through:
 * reserves budget via the sink before spending anything, calls the injected
 * `AgentRunner` (real Codex/ModelArk in production, a fake in every test in
 * this build), and commits actual usage afterward. A denied reservation or
 * an aborted signal fails loudly rather than silently proceeding.
 */
export async function callRole(deps: RoleExecutorDeps, input: RoleCallInput): Promise<RoleCallResult> {
  if (input.signal.aborted) {
    throw new RoleExecutionCancelledError();
  }
  const modelId = resolveModelId(deps, input.role);
  const executionId = randomUUID();
  const decision = await deps.sink.reserveModelCall({
    orchestrationId: input.orchestrationId,
    taskId: input.taskId,
    executionId,
    role: input.role,
    modelId,
    estimatedInputTokens: input.estimatedInputTokens,
    estimatedOutputTokens: input.estimatedOutputTokens,
  });
  if (!decision.allowed) {
    throw new BudgetDeniedError(input.role, decision.reason);
  }
  if (input.signal.aborted) {
    throw new RoleExecutionCancelledError();
  }

  const result = await deps.runner.run({
    agentId: input.agentId,
    workspacePath: input.workspacePath,
    prompt: input.prompt,
    threadId: input.threadId,
    executionId,
    sandboxMode: input.sandboxMode,
  });

  const actual: TokenUsage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
  await deps.sink.commitModelUsage(decision.reservationId, actual);

  return { output: result.output, threadId: result.threadId, usage: actual, modelId, executionId };
}

/**
 * `callRole` plus schema-validated structured output with one bounded
 * repair round-trip. The repair call is itself a real, separately budgeted
 * `callRole` invocation (not a free retry) — the ledger records both calls
 * if a repair happens.
 */
export async function callRoleStructured<T>(
  deps: RoleExecutorDeps,
  input: RoleCallInput,
  schema: z.ZodType<T>,
): Promise<{ value: T; usage: TokenUsage; modelId: string; repaired: boolean }> {
  const first = await callRole(deps, input);
  const result = await parseStructuredOutput(schema, first.output, async (previous, error) => {
    const repairCall = await callRole(deps, {
      ...input,
      prompt: [
        "Your previous response could not be parsed as the required JSON shape.",
        `Validation error: ${error}`,
        "Previous response:",
        previous,
        "",
        "Respond again with ONLY valid JSON matching the required shape — no prose, no code fences.",
      ].join("\n"),
      threadId: first.threadId,
    });
    return repairCall.output;
  });
  return { value: result.value, usage: first.usage, modelId: first.modelId, repaired: result.repaired };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
