import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetPolicySchema } from "../control/budget-ledger.js";
import type { ExecutionContract, OrchestrationTask } from "../contracts.js";
import { buildContextPacket } from "./context-broker.js";
import type { ApplicationMap } from "./application-map.js";
import { BudgetDeniedError } from "./role-executor.js";
import { createFakeAgentRunner, createInMemorySink } from "./test-doubles.js";
import { runWorkerLoop } from "./worker-loop.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orch-1",
  version: 1,
  intent: {
    id: "draft-1",
    orchestrationId: "orch-1",
    revision: 0,
    goal: "Add password reset",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    manualExpectations: [],
    openQuestions: [],
    createdAt: new Date().toISOString(),
  },
  criteria: [
    { id: "crit-1", kind: "functional", description: "Add reset endpoint", verification: "visible-test", provenance: "user-explicit", sourceClaimId: null },
  ],
  confirmedBy: "user",
  confirmedAt: new Date().toISOString(),
  supersedesContractId: null,
};

function buildTask(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id: "task-1",
    orchestrationId: "orch-1",
    title: "Auth work",
    objective: "Add password reset",
    status: "ready",
    dependsOn: [],
    allowedPaths: ["src/auth"],
    acceptanceCriterionIds: ["crit-1"],
    requiredArtifactIds: [],
    observedArtifactVersions: {},
    applicationMapVersion: 1,
    attemptCount: 0,
    ...overrides,
  };
}

const emptyMap: ApplicationMap = {
  summary: { orchestrationId: "orch-1", version: 1, repositoryHash: "h", summary: "", fileCount: 0, createdAt: new Date().toISOString() },
  files: [],
  directories: [],
};

const preflightPlanJson = JSON.stringify({
  understanding: "Add reset endpoint",
  filesExpectedToChange: ["src/auth/reset.ts"],
  approach: "Add handler",
  missingContextRequests: [],
  plannedChecks: ["unit"],
});

describe("runWorkerLoop", () => {
  it("passes on the first attempt: preflight approves, a real file is written and diffed, checks pass", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(async (request) => {
      if (request.sandboxMode === "read-only") {
        return { output: preflightPlanJson, threadId: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } };
      }
      await mkdir(path.join(request.workspacePath, "src", "auth"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "src", "auth", "reset.ts"), "export function reset() {}\n");
      return { output: "Added reset handler", threadId: null, usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 15 } };
    });

    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});
    const result = await runWorkerLoop(
      { roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" }, scratchRoot, checkRunner: async () => ({ status: "passed", outputSummary: "ok" }) },
      "orch-1",
      "agent-1",
      contract,
      buildTask(),
      packet,
      source,
      budgetPolicySchema.parse({}),
      new AbortController().signal,
    );

    expect(result.status).toBe("passed");
    expect(result.changedFiles).toEqual(["src/auth/reset.ts"]);
    expect(sink.attempts).toHaveLength(1);
    expect(sink.attempts[0]?.status).toBe("passed");
    expect(sink.contextPackets).toHaveLength(1);
  });

  it("retries after a failing visible check and then passes on the second attempt", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    const sink = createInMemorySink();
    let writeCalls = 0;
    const runner = createFakeAgentRunner(async (request) => {
      if (request.sandboxMode === "read-only") {
        return { output: preflightPlanJson, threadId: null, usage: null };
      }
      writeCalls += 1;
      await mkdir(path.join(request.workspacePath, "src", "auth"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "src", "auth", "reset.ts"), `attempt ${writeCalls}\n`);
      return { output: "edited", threadId: null, usage: null };
    });
    let checkCalls = 0;
    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});

    const result = await runWorkerLoop(
      {
        roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        scratchRoot,
        checkRunner: async () => {
          checkCalls += 1;
          return checkCalls === 1 ? { status: "failed", outputSummary: "assertion failed" } : { status: "passed", outputSummary: "ok" };
        },
      },
      "orch-1",
      "agent-1",
      contract,
      buildTask(),
      packet,
      source,
      budgetPolicySchema.parse({ maxWorkerAttempts: 3 }),
      new AbortController().signal,
    );

    expect(result.status).toBe("passed");
    expect(result.attempts).toBe(2);
    expect(sink.attempts).toHaveLength(2);
    expect(sink.attempts[0]?.status).toBe("failed");
    expect(sink.attempts[1]?.status).toBe("passed");
  });

  it("fails after exhausting the attempt budget and returns a compact failure packet", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(async (request) => {
      if (request.sandboxMode === "read-only") return { output: preflightPlanJson, threadId: null, usage: null };
      return { output: "edited but broken", threadId: null, usage: null };
    });
    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});

    const result = await runWorkerLoop(
      {
        roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        scratchRoot,
        checkRunner: async () => ({ status: "failed", outputSummary: "always fails" }),
      },
      "orch-1",
      "agent-1",
      contract,
      buildTask(),
      packet,
      source,
      budgetPolicySchema.parse({ maxWorkerAttempts: 2 }),
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(2);
    expect(result.failurePacket).not.toBeNull();
    expect(result.failurePacket?.attemptCount).toBe(2);
    expect(result.failurePacket?.failingChecks.length).toBeGreaterThan(0);
  });

  it("rejects preflight and retries when the plan proposes files outside the task's allowed paths", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    const sink = createInMemorySink();
    const outOfScopePlan = JSON.stringify({
      understanding: "x",
      filesExpectedToChange: ["src/billing/invoice.ts"],
      approach: "x",
      missingContextRequests: [],
      plannedChecks: [],
    });
    const runner = createFakeAgentRunner(() => ({ output: outOfScopePlan, threadId: null, usage: null }));
    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});

    const result = await runWorkerLoop(
      { roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" }, scratchRoot, checkRunner: async () => ({ status: "passed", outputSummary: "ok" }) },
      "orch-1",
      "agent-1",
      contract,
      buildTask(),
      packet,
      source,
      budgetPolicySchema.parse({ maxWorkerAttempts: 1 }),
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    expect(result.failurePacket?.lastError).toMatch(/preflight rejected/i);
    // no writable call should have happened: no changed files
    expect(result.changedFiles).toEqual([]);
  });

  it("stops immediately on budget denial rather than burning further attempts", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    // low enough that even the first (500-token-estimated) preflight reservation is denied
    const tightBudget = budgetPolicySchema.parse({ maxInputTokens: 1, maxWorkerAttempts: 5 });
    const sink = createInMemorySink(tightBudget);
    let preflightCalls = 0;
    const runner = createFakeAgentRunner(() => {
      preflightCalls += 1;
      return { output: preflightPlanJson, threadId: null, usage: null };
    });
    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});

    await expect(
      runWorkerLoop(
        { roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" }, scratchRoot, checkRunner: async () => ({ status: "passed", outputSummary: "ok" }) },
        "orch-1",
        "agent-1",
        contract,
        buildTask(),
        packet,
        source,
        tightBudget,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    // the reservation was denied before the runner was ever invoked — no wasted call
    expect(preflightCalls).toBe(0);
    expect(sink.attempts).toHaveLength(1);
    expect(sink.attempts[0]?.status).toBe("failed");
  });

  it("returns cancelled without doing any work when the signal is already aborted", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    const sink = createInMemorySink();
    let runnerCalled = false;
    const runner = createFakeAgentRunner(() => {
      runnerCalled = true;
      return { output: preflightPlanJson, threadId: null, usage: null };
    });
    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkerLoop(
      { roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" }, scratchRoot, checkRunner: async () => ({ status: "passed", outputSummary: "ok" }) },
      "orch-1",
      "agent-1",
      contract,
      buildTask(),
      packet,
      source,
      budgetPolicySchema.parse({}),
      controller.signal,
    );
    expect(result.status).toBe("cancelled");
    expect(runnerCalled).toBe(false);
  });

  it("grants a narrow in-workspace context expansion the worker requested, and denies a traversal attempt", async () => {
    const source = await tempDir("worker-loop-source-");
    const scratchRoot = await tempDir("worker-loop-scratch-");
    const sink = createInMemorySink();
    const preflightWithRequests = JSON.stringify({
      understanding: "x",
      filesExpectedToChange: ["src/auth/reset.ts"],
      approach: "x",
      missingContextRequests: ["src/shared/email-service.ts", "../../etc/passwd"],
      plannedChecks: [],
    });
    let sawGrantedInPrompt = false;
    const runner = createFakeAgentRunner(async (request) => {
      if (request.sandboxMode === "read-only") {
        return { output: preflightWithRequests, threadId: null, usage: null };
      }
      sawGrantedInPrompt = request.prompt.includes("src/shared/email-service.ts");
      await mkdir(path.join(request.workspacePath, "src", "auth"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "src", "auth", "reset.ts"), "done\n");
      return { output: "done", threadId: null, usage: null };
    });
    const packet = buildContextPacket("task-1", emptyMap, 1, ["src/auth"], {});

    const result = await runWorkerLoop(
      { roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" }, scratchRoot, checkRunner: async () => ({ status: "passed", outputSummary: "ok" }) },
      "orch-1",
      "agent-1",
      contract,
      buildTask(),
      packet,
      source,
      budgetPolicySchema.parse({ maxContextExpansionsPerTask: 3 }),
      new AbortController().signal,
    );

    expect(result.status).toBe("passed");
    expect(sawGrantedInPrompt).toBe(true);
    const grantedEvent = sink.events.find((event) => event.type === "context-expansion-granted");
    const deniedEvent = sink.events.find((event) => event.type === "context-expansion-denied");
    expect(grantedEvent?.summary).toContain("src/shared/email-service.ts");
    expect(deniedEvent?.summary).toMatch(/escapes/i);
  });
});
