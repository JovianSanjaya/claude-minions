import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import type {
  ApplicationMapSummary,
  BudgetDecision,
  ContextPacketSummary,
  ModelCallReservation,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { RoleExecutor, runnerCapabilityProbe, toTokenUsage } from "./role-executor.js";

class RecordingSink implements OrchestrationSink {
  readonly events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  readonly reservations: ModelCallReservation[] = [];
  readonly commits: Array<{ reservationId: string; actual: TokenUsage }> = [];
  denyAfter = Number.POSITIVE_INFINITY;

  async reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision> {
    this.reservations.push(input);
    if (this.reservations.length > this.denyAfter) {
      return { allowed: false, reason: "Model-call budget exhausted" };
    }
    return { allowed: true, reservationId: "reservation-" + this.reservations.length };
  }
  async commitModelUsage(reservationId: string, actual: TokenUsage): Promise<void> {
    this.commits.push({ reservationId, actual });
  }
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {
    this.events.push(event);
  }
  async upsertTask(_task: OrchestrationTask): Promise<void> {}
  async recordApplicationMap(_map: ApplicationMapSummary): Promise<void> {}
  async recordContextPacket(_packet: ContextPacketSummary): Promise<void> {}
  async recordAttempt(_attempt: WorkerAttempt): Promise<void> {}
  async publishArtifact(_artifact: SharedArtifact): Promise<void> {}
  async recordVerification(_record: VerificationRecord): Promise<void> {}
}

class ScriptedRunner implements AgentRunner {
  readonly calls: RunnerRequest[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly responses: Array<RunnerResult | Error>) {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push({ ...request });
    const next = this.responses.shift();
    if (!next) throw new Error("No scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }
  async cancel(executionId: string): Promise<boolean> {
    this.cancelled.push(executionId);
    return true;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const reply = (output: string): RunnerResult => ({
  output,
  threadId: "thread-1",
  usage: { inputTokens: 100, cachedInputTokens: 5, outputTokens: 20 },
});

const schema = z.object({ status: z.string(), files: z.array(z.string()) });

function makeExecutor(
  runner: AgentRunner,
  options: {
    sink?: RecordingSink;
    supportsModelOverride?: boolean;
    signal?: AbortSignal;
    models?: { fallbackModelId: string; planner?: string; worker?: string };
  } = {},
) {
  const sink = options.sink ?? new RecordingSink();
  let counter = 0;
  const executor = new RoleExecutor({
    orchestrationId: "orc-1",
    agentId: "agent-1",
    runner,
    sink,
    models: options.models ?? {
      fallbackModelId: "ep-ark-default",
      planner: "ep-strong",
      worker: "ep-cheap",
    },
    probe: {
      supportsModelOverride: async () => options.supportsModelOverride ?? true,
    },
    signal: options.signal ?? new AbortController().signal,
    runtimeHomes: { planner: "/runtime/planner", worker: "/runtime/worker" },
    idFactory: () => "exec-" + ++counter,
  });
  return { executor, sink };
}

describe("logical role and model selection", () => {
  it("uses the configured per-role model when the Runtime supports an override", async () => {
    const runner = new ScriptedRunner([reply("done")]);
    const { executor } = makeExecutor(runner);
    const result = await executor.callText({
      role: "worker",
      taskId: "task-1",
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
      summary: "worker call",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.modelId).toBe("ep-cheap");
    expect(result.modelFallback).toBe(false);
    expect(runner.calls[0]?.modelId).toBe("ep-cheap");
    expect(runner.calls[0]?.role).toBe("worker");
    expect(runner.calls[0]?.sandboxMode).toBe("workspace-write");
    expect(runner.calls[0]?.runtimeHomePath).toBe("/runtime/worker");
    expect(runner.calls[0]?.orchestrationId).toBe("orc-1");
    expect(runner.calls[0]?.taskId).toBe("task-1");
    expect(runner.calls[0]?.executionId).toBe("exec-1");
  });

  it("falls back truthfully when the Runtime has no model flag", async () => {
    const runner = new ScriptedRunner([reply("done")]);
    const { executor, sink } = makeExecutor(runner, { supportsModelOverride: false });
    const resolved = await executor.resolveModel("worker");
    expect(resolved).toMatchObject({ modelId: "ep-ark-default", fallback: true });
    expect(resolved.fallbackReason).toContain("does not accept a model override");

    await executor.callText({
      role: "worker",
      taskId: null,
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "read-only",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });

    // No fabricated model argument reaches the Runtime.
    expect(runner.calls[0]?.modelId).toBeUndefined();
    const event = sink.events.find((item) => item.type === "model.call");
    expect(event?.modelId).toBe("ep-ark-default");
    expect(event?.metadata.modelFallback).toBe(true);
    expect(String(event?.metadata.modelFallbackReason)).toContain("configured Ark model");
  });

  it("marks a role without its own configured model as a fallback", async () => {
    const runner = new ScriptedRunner([reply("done")]);
    const { executor } = makeExecutor(runner, {
      models: { fallbackModelId: "ep-ark-default", planner: "ep-strong" },
    });
    expect(await executor.resolveModel("verifier")).toMatchObject({
      modelId: "ep-ark-default",
      fallback: true,
    });
    expect(await executor.resolveModel("planner")).toMatchObject({
      modelId: "ep-strong",
      fallback: false,
    });
  });

  it("adapts a runner without a capability probe to no override support", async () => {
    const probe = runnerCapabilityProbe(new ScriptedRunner([]));
    expect(await probe.supportsModelOverride()).toBe(false);
  });
});

describe("budget and usage accounting", () => {
  it("reserves before the call and commits the actual usage", async () => {
    const runner = new ScriptedRunner([reply("done")]);
    const { executor, sink } = makeExecutor(runner);
    await executor.callText({
      role: "planner",
      taskId: null,
      prompt: "plan",
      workspacePath: "/tmp/main",
      sandboxMode: "read-only",
      estimatedInputTokens: 1_234.6,
      estimatedOutputTokens: 500,
      summary: "planner call",
    });

    expect(sink.reservations[0]).toMatchObject({
      role: "planner",
      modelId: "ep-strong",
      executionId: "exec-1",
      estimatedInputTokens: 1_235,
    });
    expect(sink.commits[0]).toEqual({
      reservationId: "reservation-1",
      actual: { inputTokens: 100, cachedInputTokens: 5, outputTokens: 20 },
    });
  });

  it("returns a budget denial without calling the Runtime", async () => {
    const runner = new ScriptedRunner([reply("should not run")]);
    const sink = new RecordingSink();
    sink.denyAfter = 0;
    const { executor } = makeExecutor(runner, { sink });
    const result = await executor.callText({
      role: "worker",
      taskId: "task-1",
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });

    expect(result).toMatchObject({ kind: "budget-denied" });
    expect(runner.calls).toHaveLength(0);
    expect(sink.events.some((event) => event.type === "budget.denied")).toBe(true);
  });

  it("reports cancellation without starting a call once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new ScriptedRunner([reply("should not run")]);
    const { executor, sink } = makeExecutor(runner, { signal: controller.signal });
    const result = await executor.callText({
      role: "worker",
      taskId: null,
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });
    expect(result).toMatchObject({ kind: "cancelled" });
    expect(runner.calls).toHaveLength(0);
    expect(sink.reservations).toHaveLength(0);
  });

  it("commits zero usage and reports the error when the Runtime throws", async () => {
    const runner = new ScriptedRunner([new Error("codex exited with code 1")]);
    const { executor, sink } = makeExecutor(runner);
    const result = await executor.callText({
      role: "worker",
      taskId: null,
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });
    expect(result).toMatchObject({ kind: "error" });
    expect(sink.commits[0]?.actual).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(sink.events.some((event) => event.type === "model.call-failed")).toBe(true);
  });

  it("normalizes partial Runtime usage", () => {
    expect(toTokenUsage({ inputTokens: 7 })).toEqual({
      inputTokens: 7,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(toTokenUsage(null)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("structured output with one bounded repair", () => {
  it("accepts a valid first response without a repair call", async () => {
    const runner = new ScriptedRunner([reply('{"status":"complete","files":["a.ts"]}')]);
    const { executor, sink } = makeExecutor(runner);
    const result = await executor.callStructured(schema, "{ shape }", {
      role: "worker",
      taskId: null,
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });

    expect(result).toMatchObject({ kind: "ok" });
    expect(runner.calls).toHaveLength(1);
    expect(sink.events.some((event) => event.type === "model.output-repair")).toBe(false);
  });

  it("repairs exactly once and accumulates the usage of both calls", async () => {
    const runner = new ScriptedRunner([
      reply("I cannot produce JSON right now"),
      reply('{"status":"complete","files":[]}'),
    ]);
    const { executor, sink } = makeExecutor(runner);
    const result = await executor.callStructured(schema, "{ shape }", {
      role: "worker",
      taskId: null,
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.value).toEqual({ status: "complete", files: [] });
    expect(result.modelCalls).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 200, cachedInputTokens: 10, outputTokens: 40 });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.prompt).toContain("could not be parsed");
    expect(sink.events.filter((event) => event.type === "model.output-repair")).toHaveLength(1);
  });

  it("fails explicitly after a second invalid response and never invents a value", async () => {
    const runner = new ScriptedRunner([reply("nope"), reply("still nope")]);
    const { executor, sink } = makeExecutor(runner);
    const result = await executor.callStructured(schema, "{ shape }", {
      role: "planner",
      taskId: null,
      prompt: "plan",
      workspacePath: "/tmp/main",
      sandboxMode: "read-only",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "planner call",
    });

    expect(result).toMatchObject({ kind: "invalid-output" });
    expect(runner.calls).toHaveLength(2);
    expect(sink.events.some((event) => event.type === "model.output-invalid")).toBe(true);
  });

  it("does not spend a repair call when the budget denies it", async () => {
    const runner = new ScriptedRunner([reply("not json")]);
    const sink = new RecordingSink();
    sink.denyAfter = 1;
    const { executor } = makeExecutor(runner, { sink });
    const result = await executor.callStructured(schema, "{ shape }", {
      role: "worker",
      taskId: null,
      prompt: "work",
      workspacePath: "/tmp/worker",
      sandboxMode: "workspace-write",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "worker call",
    });
    expect(result).toMatchObject({ kind: "budget-denied" });
    expect(runner.calls).toHaveLength(1);
  });
});

describe("evidence safety", () => {
  it("records role and model evidence without the prompt or the raw response body", async () => {
    const runner = new ScriptedRunner([reply("secret internal reasoning about ARK_API_KEY")]);
    const { executor, sink } = makeExecutor(runner);
    await executor.callText({
      role: "verifier",
      taskId: "task-1",
      prompt: "very long private prompt with source code",
      workspacePath: "/tmp/staging",
      sandboxMode: "read-only",
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      summary: "verifier call",
      metadata: { stage: "verify" },
    });

    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain("very long private prompt");
    expect(serialized).not.toContain("secret internal reasoning");
    const event = sink.events.find((item) => item.type === "model.call");
    expect(event).toMatchObject({
      actorRole: "verifier",
      taskId: "task-1",
      executionId: "exec-1",
    });
    expect(event?.metadata).toMatchObject({ stage: "verify", inputTokens: 100, outputTokens: 20 });
  });
});
