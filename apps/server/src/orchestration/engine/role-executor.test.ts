import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RunnerExecutionError } from "../../errors.js";
import type { AgentRunner } from "../../types.js";
import type { OrchestrationSink } from "../contracts.js";
import {
  isRetryableRoleTransportFailure,
  isRoleRuntimeTimeout,
  isVerificationInfrastructureFailure,
  RoleExecutor,
  transportRetryDelayMs,
} from "./role-executor.js";

describe("RoleExecutor", () => {
  it("retries a zero-turn transport disconnect in a fresh thread", async () => {
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
        threadId: null,
      }));
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: "role-call-transport-retry",
        metadata: expect.objectContaining({
          partialArkApiTurns: 0,
          partialInputTokens: 0,
          resumesThread: false,
          freshThreadAfterZeroTurnDisconnect: true,
        }),
      }));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("backs transient provider retries off long enough to survive a short outage", () => {
    expect([1, 2, 3, 4, 5, 6].map(transportRetryDelayMs)).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
    ]);
  });

  it("does not replay a full runtime timeout as a transport retry", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-timeout-"));
    const run = vi.fn().mockRejectedValue(new RunnerExecutionError(
      "Runtime timed out after 150000 ms",
      {
        threadId: "timed-out-thread",
        output: null,
        usage: { inputTokens: 20_000, outputTokens: 2_000, arkApiTurns: 2, toolCalls: 2 },
      },
    ));
    const sink = {
      reserveModelCall: vi.fn().mockResolvedValue({ allowed: true, reservationId: "reservation" }),
      commitModelUsage: vi.fn().mockResolvedValue(undefined),
      recordEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrchestrationSink;
    try {
      const roles = new RoleExecutor(
        { run, cancel: vi.fn().mockResolvedValue(false) } as unknown as AgentRunner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
        undefined,
        600_000,
        6,
      );

      await expect(roles.text({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: null,
        role: "verifier",
        workspacePath: runtimeRoot,
        prompt: "verify",
        sandboxMode: "read-only",
        signal: new AbortController().signal,
      })).rejects.toThrow("Runtime timed out after 150000 ms");

      expect(run).toHaveBeenCalledTimes(1);
      expect(isRoleRuntimeTimeout(new Error("Runtime timed out after 150000 ms"))).toBe(true);
      expect(isRetryableRoleTransportFailure(new Error("Runtime timed out after 150000 ms"))).toBe(false);
      expect(isVerificationInfrastructureFailure(new Error("Runtime timed out after 150000 ms"))).toBe(true);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("allows a verifier call to override the global transport retry count", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-override-"));
    const run = vi.fn().mockRejectedValue(new RunnerExecutionError(
      "stream disconnected before completion",
      { threadId: null, output: null, usage: null },
    ));
    const sink = {
      reserveModelCall: vi.fn().mockResolvedValue({ allowed: true, reservationId: "reservation" }),
      commitModelUsage: vi.fn().mockResolvedValue(undefined),
      recordEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrchestrationSink;
    try {
      const roles = new RoleExecutor(
        { run, cancel: vi.fn().mockResolvedValue(false) } as unknown as AgentRunner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
        undefined,
        600_000,
        6,
      );

      await expect(roles.text({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: null,
        role: "verifier",
        workspacePath: runtimeRoot,
        prompt: "verify",
        sandboxMode: "read-only",
        signal: new AbortController().signal,
        maxTransportRetries: 0,
      })).rejects.toThrow("stream disconnected");

      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("includes a large invalid structured response in the repair call", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-repair-"));
    const trailingMarker = "TRAILING-CONFLICTING-TASKS";
    const invalidOutput = JSON.stringify({ padding: "x".repeat(9_000), marker: trailingMarker });
    const run = vi.fn()
      .mockResolvedValueOnce({ output: invalidOutput, threadId: "thread-1", usage: null })
      .mockResolvedValueOnce({ output: '{"ok":true}', threadId: "thread-2", usage: null });
    const sink = {
      reserveModelCall: vi.fn().mockResolvedValue({ allowed: true, reservationId: "reservation" }),
      commitModelUsage: vi.fn().mockResolvedValue(undefined),
      recordEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrchestrationSink;
    try {
      const roles = new RoleExecutor(
        { run, cancel: vi.fn().mockResolvedValue(false) } as unknown as AgentRunner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
      );
      const result = await roles.structured({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: null,
        role: "planner",
        workspacePath: runtimeRoot,
        prompt: "plan",
        sandboxMode: "read-only",
        signal: new AbortController().signal,
      }, z.object({ ok: z.boolean() }).strict());
      expect(result.value).toEqual({ ok: true });
      expect(run.mock.calls[1]?.[0].prompt).toContain(trailingMarker);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shares turn, token, and tool limits with the structured-output repair", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-shared-budget-"));
    const run = vi.fn()
      .mockResolvedValueOnce({
        output: "not json",
        threadId: "thread-1",
        usage: { inputTokens: 20_000, outputTokens: 100, arkApiTurns: 2, toolCalls: 1 },
      })
      .mockResolvedValueOnce({
        output: '{"ok":true}',
        threadId: "thread-2",
        usage: { inputTokens: 5_000, outputTokens: 20, arkApiTurns: 1, toolCalls: 0 },
      });
    const sink = {
      reserveModelCall: vi.fn().mockResolvedValue({ allowed: true, reservationId: "reservation" }),
      commitModelUsage: vi.fn().mockResolvedValue(undefined),
      recordEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrchestrationSink;
    try {
      const roles = new RoleExecutor(
        { run, cancel: vi.fn().mockResolvedValue(false) } as unknown as AgentRunner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
      );
      await roles.structured({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: null,
        role: "verifier",
        workspacePath: runtimeRoot,
        prompt: "verify",
        sandboxMode: "read-only",
        signal: new AbortController().signal,
        maxArkApiTurns: 5,
        maxInputTokens: 50_000,
        maxToolCalls: 4,
      }, z.object({ ok: z.boolean() }).strict());

      expect(run.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        maxArkApiTurns: 3,
        maxInputTokens: 30_000,
        maxToolCalls: 3,
      }));
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not start a structured-output repair after the shared budget is exhausted", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "role-executor-exhausted-budget-"));
    const run = vi.fn().mockResolvedValue({
      output: "not json",
      threadId: "thread-1",
      usage: { inputTokens: 40_000, outputTokens: 100, arkApiTurns: 2, toolCalls: 2 },
    });
    const sink = {
      reserveModelCall: vi.fn().mockResolvedValue({ allowed: true, reservationId: "reservation" }),
      commitModelUsage: vi.fn().mockResolvedValue(undefined),
      recordEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrchestrationSink;
    try {
      const roles = new RoleExecutor(
        { run, cancel: vi.fn().mockResolvedValue(false) } as unknown as AgentRunner,
        sink,
        { planner: "big", worker: "small", verifier: "big", integrator: "big" },
        runtimeRoot,
      );
      await expect(roles.structured({
        orchestrationId: "orchestration-1",
        agentId: "agent-1",
        taskId: null,
        role: "verifier",
        workspacePath: runtimeRoot,
        prompt: "verify",
        sandboxMode: "read-only",
        signal: new AbortController().signal,
        maxArkApiTurns: 2,
        maxInputTokens: 40_000,
        maxToolCalls: 2,
      }, z.object({ ok: z.boolean() }).strict())).rejects.toThrow("repair budget was exhausted");
      expect(run).toHaveBeenCalledTimes(1);
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
