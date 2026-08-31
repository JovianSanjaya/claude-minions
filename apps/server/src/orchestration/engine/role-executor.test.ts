import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunnerExecutionError } from "../../errors.js";
import type { AgentRunner } from "../../types.js";
import type { OrchestrationSink } from "../contracts.js";
import { RoleExecutor } from "./role-executor.js";

describe("RoleExecutor", () => {
  it("retries a zero-turn transport disconnect independently and resumes the created thread", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-retry-"));
    let reservation = 0;
    let execution = 0;
    const recordEvent = vi.fn().mockResolvedValue(undefined);
    const sink = {
      reserveModelCall: vi.fn().mockImplementation(async () => ({
        allowed: true,
        reservationId: `reservation-${++reservation}`,
      })),
      commitModelUsage: vi.fn().mockResolvedValue(undefined),
      recordEvent,
    } as unknown as OrchestrationSink;
    const run = vi.fn()
      .mockRejectedValueOnce(new RunnerExecutionError(
        "stream disconnected before completion: error sending request",
        {
          threadId: "thread-created-before-disconnect",
          output: null,
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            arkApiTurns: 0,
            toolCalls: 0,
          },
        },
      ))
      .mockResolvedValueOnce({
        output: "HEALTHY",
        threadId: "thread-created-before-disconnect",
        usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, arkApiTurns: 1 },
        modelId: "big",
      });
    const runner = {
      run,
      cancel: vi.fn().mockResolvedValue(false),
    } as unknown as AgentRunner;
    try {
      const roles = new RoleExecutor(
        runner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
        () => `execution-${++execution}`,
        600_000,
        1,
      );

      const result = await roles.text({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: null,
        role: "planner",
        workspacePath: runtimeRoot,
        prompt: "plan",
        sandboxMode: "read-only",
        signal: new AbortController().signal,
      });

      expect(result.value).toBe("HEALTHY");
      expect(result.usage).toEqual(expect.objectContaining({
        inputTokens: 10,
        outputTokens: 2,
        arkApiTurns: 1,
      }));
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        threadId: "thread-created-before-disconnect",
      }));
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "role-call-transport-retry",
        metadata: expect.objectContaining({
          partialArkApiTurns: 0,
          partialInputTokens: 0,
          resumesThread: true,
        }),
      }));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("commits partial Ark usage when an execution disconnects", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-"));
    const commitModelUsage = vi.fn().mockResolvedValue(undefined);
    const recordEvent = vi.fn().mockResolvedValue(undefined);
    const sink = {
      reserveModelCall: vi.fn().mockResolvedValue({
        allowed: true,
        reservationId: "reservation-1",
      }),
      commitModelUsage,
      recordEvent,
    } as unknown as OrchestrationSink;
    const runner = {
      run: vi.fn().mockRejectedValue(new RunnerExecutionError("stream disconnected", {
        threadId: "thread-1",
        output: null,
        usage: {
          inputTokens: 120,
          cachedInputTokens: 80,
          outputTokens: 10,
          arkApiTurns: 3,
          toolCalls: 2,
          streamRetries: 1,
          peakContextTokens: 55,
        },
      })),
      cancel: vi.fn().mockResolvedValue(false),
    } as unknown as AgentRunner;
    try {
      const roles = new RoleExecutor(
        runner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
        () => "execution-1",
        600_000,
        0,
      );

      await expect(roles.text({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: "task-1",
        role: "worker",
        workspacePath: runtimeRoot,
        prompt: "work",
        sandboxMode: "workspace-write",
        signal: new AbortController().signal,
      })).rejects.toThrow("stream disconnected");

      expect(commitModelUsage).toHaveBeenCalledWith("reservation-1", {
        inputTokens: 120,
        cachedInputTokens: 80,
        outputTokens: 10,
        arkApiTurns: 3,
        toolCalls: 2,
        streamRetries: 1,
        peakContextTokens: 55,
      });
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "role-call-failed",
        metadata: expect.objectContaining({ arkApiTurns: 3, toolCalls: 2 }),
      }));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});
