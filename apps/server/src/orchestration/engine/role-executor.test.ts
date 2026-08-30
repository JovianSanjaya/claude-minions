import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_BUDGET_POLICY, budgetPolicySchema } from "../control/budget-ledger.js";
import {
  BudgetDeniedError,
  RoleExecutionCancelledError,
  callRole,
  callRoleStructured,
} from "./role-executor.js";
import { createFakeAgentRunner, createInMemorySink, usageResult } from "./test-doubles.js";

const baseInput = {
  agentId: "agent-1",
  orchestrationId: "orch-1",
  taskId: null,
  role: "worker" as const,
  prompt: "do the thing",
  workspacePath: "/workspaces/agent-1",
  threadId: null,
  estimatedInputTokens: 100,
  estimatedOutputTokens: 50,
};

describe("callRole", () => {
  it("reserves budget, calls the runner, and commits actual usage", async () => {
    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({
      output: "done",
      threadId: "thread-1",
      usage: usageResult({ inputTokens: 80, outputTokens: 40 }),
    }));
    const result = await callRole(
      { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
      { ...baseInput, signal: new AbortController().signal },
    );
    expect(result.output).toBe("done");
    expect(result.modelId).toBe("ep-default");
    expect(sink.getUsage().byRole.worker?.inputTokens).toBe(80);
    expect(sink.getUsage().byRole.worker?.modelCalls).toBe(1);
  });

  it("uses the role-specific model id when configured, and truthfully falls back otherwise", async () => {
    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({ output: "ok", threadId: null, usage: null }));
    const withOverride = await callRole(
      { runner, sink, modelIds: { worker: "ep-worker-cheap" }, defaultModelId: "ep-default" },
      { ...baseInput, signal: new AbortController().signal },
    );
    expect(withOverride.modelId).toBe("ep-worker-cheap");

    const withoutOverride = await callRole(
      { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
      { ...baseInput, role: "planner", signal: new AbortController().signal },
    );
    expect(withoutOverride.modelId).toBe("ep-default");
  });

  it("throws BudgetDeniedError and never calls the runner when the reservation is denied", async () => {
    const tightBudget = budgetPolicySchema.parse({ maxInputTokens: 5 });
    const sink = createInMemorySink(tightBudget);
    let runnerCalled = false;
    const runner = createFakeAgentRunner(() => {
      runnerCalled = true;
      return { output: "should not happen", threadId: null, usage: null };
    });
    await expect(
      callRole(
        { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        { ...baseInput, estimatedInputTokens: 100, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    expect(runnerCalled).toBe(false);
  });

  it("throws RoleExecutionCancelledError and never reserves budget when the signal is already aborted", async () => {
    const sink = createInMemorySink();
    const controller = new AbortController();
    controller.abort();
    const runner = createFakeAgentRunner(() => ({ output: "x", threadId: null, usage: null }));
    await expect(
      callRole({ runner, sink, modelIds: {}, defaultModelId: "ep-default" }, { ...baseInput, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RoleExecutionCancelledError);
    expect(sink.getUsage().totalInputTokens).toBe(0);
  });
});

describe("callRoleStructured", () => {
  const schema = z.object({ answer: z.string() });

  it("parses valid structured output on the first call without a repair", async () => {
    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({ output: '{"answer":"42"}', threadId: null, usage: null }));
    const result = await callRoleStructured(
      { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
      { ...baseInput, signal: new AbortController().signal },
      schema,
    );
    expect(result.repaired).toBe(false);
    expect(result.value.answer).toBe("42");
    expect(sink.getUsage().byRole.worker?.modelCalls).toBe(1);
  });

  it("makes one real, separately-budgeted repair call when the first output is malformed", async () => {
    const sink = createInMemorySink();
    let calls = 0;
    const runner = createFakeAgentRunner(() => {
      calls += 1;
      if (calls === 1) return { output: "not json", threadId: null, usage: usageResult() };
      return { output: '{"answer":"fixed"}', threadId: null, usage: usageResult() };
    });
    const result = await callRoleStructured(
      { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
      { ...baseInput, signal: new AbortController().signal },
      schema,
    );
    expect(result.repaired).toBe(true);
    expect(result.value.answer).toBe("fixed");
    expect(calls).toBe(2);
    // both calls were real, budgeted, and committed
    expect(sink.getUsage().byRole.worker?.modelCalls).toBe(2);
  });

  it("fails explicitly after the bounded repair also produces malformed output", async () => {
    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({ output: "still not json", threadId: null, usage: null }));
    await expect(
      callRoleStructured(
        { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        { ...baseInput, signal: new AbortController().signal },
        schema,
      ),
    ).rejects.toThrow(/structured output/i);
  });
});
