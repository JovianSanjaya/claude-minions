import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  BudgetDecision,
  ModelCallReservation,
  OrchestrationEvent,
  OrchestrationSink,
  TokenUsage,
} from "../contracts.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import { BudgetDeniedError, RoleExecutor } from "./role-executor.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class RoleSink {
  reservations: ModelCallReservation[] = [];
  usage: TokenUsage[] = [];
  events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  deny = false;
  async reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision> {
    this.reservations.push(input);
    return this.deny
      ? { allowed: false, reason: "token budget exhausted" }
      : { allowed: true, reservationId: `r-${this.reservations.length}` };
  }
  async commitModelUsage(_id: string, usage: TokenUsage): Promise<void> {
    this.usage.push(usage);
  }
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {
    this.events.push(event);
  }
}

describe("role executor", () => {
  it("repairs malformed structured output once and records truthful fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "role-executor-"));
    roots.push(root);
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request): Promise<RunnerResult> => {
        requests.push(request);
        return {
          output: requests.length === 1 ? "not-json" : '{"ok":true}',
          threadId: null,
          usage: { inputTokens: 2, outputTokens: 1 },
          modelId: "base",
          modelFallback: true,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const sink = new RoleSink();
    const executor = new RoleExecutor({
      runner,
      models: { planner: "strong", worker: "cheap", verifier: "verify", integrator: "strong" },
      baseModelId: "base",
      modelOverrideSupported: false,
      runtimeHomeRoot: path.join(root, "homes"),
      idProvider: (() => {
        let value = 0;
        return () => String(++value);
      })(),
    });
    const result = await executor.callStructured(
      {
        orchestrationId: "orch",
        taskId: null,
        agentId: "agent",
        role: "planner",
        prompt: "json please",
        workspacePath: root,
        sandboxMode: "read-only",
        estimatedInputTokens: 10,
        estimatedOutputTokens: 10,
        sink: sink as unknown as OrchestrationSink,
        signal: new AbortController().signal,
      },
      z.object({ ok: z.boolean() }).strict(),
      "{ok:boolean}",
    );
    expect(result.value).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 4, cachedInputTokens: 0, outputTokens: 2 });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.modelId === undefined)).toBe(true);
    expect(result).toMatchObject({ modelId: "base", modelFallback: true });
    expect(sink.events.some((event) => event.type === "model.structured-output-repair")).toBe(true);
  });

  it("stops before invoking the runner when the sink denies budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "role-budget-"));
    roots.push(root);
    let invoked = false;
    const runner: AgentRunner = {
      run: async () => {
        invoked = true;
        throw new Error("must not run");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const sink = new RoleSink();
    sink.deny = true;
    const executor = new RoleExecutor({
      runner,
      models: { planner: "strong", worker: "cheap", verifier: "verify", integrator: "strong" },
      baseModelId: "base",
      modelOverrideSupported: true,
      runtimeHomeRoot: path.join(root, "homes"),
    });
    await expect(
      executor.callText({
        orchestrationId: "orch",
        taskId: null,
        agentId: "agent",
        role: "worker",
        prompt: "work",
        workspacePath: root,
        sandboxMode: "workspace-write",
        estimatedInputTokens: 10,
        estimatedOutputTokens: 10,
        sink: sink as unknown as OrchestrationSink,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    expect(invoked).toBe(false);
  });
});
