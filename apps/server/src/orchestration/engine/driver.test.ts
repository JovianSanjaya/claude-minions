import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApplicationMapSummary,
  ContextPacketSummary,
  ExecutionContract,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import type { AgentRunner } from "../../types.js";
import { RunnerExecutionError } from "../../errors.js";
import { ContextAwareExecutionDriver } from "./driver.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class Sink implements OrchestrationSink {
  events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  tasks = new Map<string, OrchestrationTask>();
  maps: ApplicationMapSummary[] = [];
  packets: ContextPacketSummary[] = [];
  attempts: WorkerAttempt[] = [];
  artifacts: SharedArtifact[] = [];
  verifications: VerificationRecord[] = [];
  calls = 0;
  async reserveModelCall(_input: ModelCallReservation) { this.calls += 1; return { allowed: true as const, reservationId: `r${this.calls}` }; }
  async commitModelUsage(_id: string, _actual: TokenUsage) {}
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">) { this.events.push(event); }
  async upsertTask(task: OrchestrationTask) { this.tasks.set(task.id, structuredClone(task)); }
  async recordApplicationMap(map: ApplicationMapSummary) { this.maps.push(map); }
  async recordContextPacket(packet: ContextPacketSummary) { this.packets.push(packet); }
  async recordAttempt(attempt: WorkerAttempt) { this.attempts.push(structuredClone(attempt)); }
  async publishArtifact(artifact: SharedArtifact) { this.artifacts.push(structuredClone(artifact)); }
  async recordVerification(record: VerificationRecord) { this.verifications.push(record); }
}

const intent = {
  goal: "Add two modules",
  requirements: ["A works", "B works"],
  assumptions: ["TypeScript"],
  nonGoals: ["No redesign"],
  architectureDecisions: ["Separate modules"],
  materialQuestions: [],
  manualExpectations: [],
  estimate: {
    inputTokenLow: 100, inputTokenHigh: 500, outputTokenLow: 100,
    outputTokenHigh: 500, estimatedUsdLow: null, estimatedUsdHigh: null,
    pricingStatus: "unknown", assumptions: ["Two workers"],
  },
};

type RecordedCall = {
  taskId: string | undefined;
  sandboxMode: string | undefined;
  allowedWritePaths: string[] | undefined;
  runtimeProfile: string | undefined;
  role: string | undefined;
  prompt: string;
  threadId: string | null | undefined;
  workspacePath: string;
};

type WorkerConcurrencyProbe = {
  active: number;
  maximumActive: number;
  startedTaskIds: string[];
  sawPredecessorOutput?: boolean;
};

function orchestration(workspace: string): Orchestration {
  return {
    id: "orchestration-1", agentId: "agent-1", prompt: "Add A and B",
    requestedMode: "orchestrated", selectedMode: null, status: "planning",
    currentIntentDraftId: "intent-1", activeContractId: "contract-1",
    estimate: intent.estimate,
    budget: {
      maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxEstimatedUsd: null,
      maxModelCalls: 100, maxSteps: 100, maxWorkerAttempts: 2,
      maxContextExpansionsPerTask: 2,
    },
    usage: { byRole: {}, totalInputTokens: 0, totalCachedInputTokens: 0, totalOutputTokens: 0, totalEstimatedUsd: null, pricingStatus: "unknown" },
    finalOutput: null, error: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null,
  };
}

function contract(): ExecutionContract {
  return {
    id: "contract-1", orchestrationId: "orchestration-1", version: 1,
    intent: { id: "intent-1", orchestrationId: "orchestration-1", revision: 1, ...intent, createdAt: new Date().toISOString() },
    criteria: [
      { id: "c1", kind: "functional", description: "A works", verification: "visible-test" },
      { id: "c2", kind: "functional", description: "B works", verification: "visible-test" },
    ],
    confirmedBy: "user", confirmedAt: new Date().toISOString(), supersedesContractId: null,
  };
}

function fakeRunner(
  failWorkers = false,
  calls: RecordedCall[] = [],
  badPreflightOnce = false,
  failAcceptance = false,
  includePostReleaseAcceptance = false,
  allowNoChangeDirect = false,
  recoveryAction: "retry-direct" | "retry-worker" | "retry-integrator" | "retry-verifier" | "needs-user" | "stop" = "stop",
  firstPlanAllowedPath: string | null = null,
  firstWorkerBudgetBoundary = false,
  firstPlanOversizedTask = false,
  firstWorkerGracefulCheckpoint = false,
  firstPlanSerialChain = false,
  workerConcurrencyProbe?: WorkerConcurrencyProbe,
  repairMutatesPlanFields = false,
  firstPlanOverTotalBudget = false,
  firstWorkerScopeViolation = false,
): AgentRunner {
  const rejectedPreflights = new Set<string>();
  let recoveryApplied = false;
  let acceptanceCalls = 0;
  let planningResponses = 0;
  let workerBudgetBoundaryRaised = false;
  let workerGracefulCheckpointRaised = false;
  let workerScopeViolationRaised = false;
  return {
    async run(request) {
      calls.push({ taskId: request.taskId, sandboxMode: request.sandboxMode, allowedWritePaths: request.allowedWritePaths, runtimeProfile: request.runtimeProfile, role: request.role, prompt: request.prompt, threadId: request.threadId, workspacePath: request.workspacePath });
      const probesWorker = Boolean(
        workerConcurrencyProbe && request.prompt.includes("Implement only this confirmed task"),
      );
      if (probesWorker && workerConcurrencyProbe) {
        workerConcurrencyProbe.active += 1;
        workerConcurrencyProbe.maximumActive = Math.max(
          workerConcurrencyProbe.maximumActive,
          workerConcurrencyProbe.active,
        );
        workerConcurrencyProbe.startedTaskIds.push(request.taskId ?? "unknown");
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      let output: string;
      if (request.prompt.includes("Elaborate the user's intent")) {
        output = JSON.stringify(intent);
      } else if (
        request.prompt.includes("Create the most execution-efficient correct coding task graph") ||
        ((firstPlanAllowedPath !== null || firstPlanOversizedTask || firstPlanSerialChain || firstPlanOverTotalBudget) && request.prompt.includes("Invalid output to repair"))
      ) {
        const isRepair = request.prompt.includes("Invalid output to repair");
        const mutatesPlanFields = repairMutatesPlanFields && isRepair;
        const firstTaskAllowedPath = planningResponses === 0 && firstPlanAllowedPath
          ? firstPlanAllowedPath
          : "src/a.ts";
        const returnOversizedTask = firstPlanOversizedTask && planningResponses === 0;
        const returnSerialChain = firstPlanSerialChain && planningResponses === 0;
        const returnOverTotalBudget = firstPlanOverTotalBudget && planningResponses === 0;
        planningResponses += 1;
        output = JSON.stringify({
          coupling: "LOW", estimatedCalls: "8",
          estimatedArkApiTurns: returnOversizedTask ? 60 : 10,
          estimatedContextTokens: "1000",
          tasks: returnOversizedTask
            ? [{ title: "Build everything", objective: "Build A and B in one oversized task", dependsOn: [], allowedPaths: ["src/a.ts", "src/b.ts"], acceptanceCriterionIds: ["c1", "c2"], requiredArtifactIds: [], estimatedArkApiTurns: 60, estimatedInputTokens: 3_000_000 }]
            : [
                { title: "Add A", objective: mutatesPlanFields ? "Unrelated rewritten objective A" : "Add A", dependsOn: [], allowedPaths: [firstTaskAllowedPath], acceptanceCriterionIds: ["c1"], requiredArtifactIds: [], estimatedArkApiTurns: mutatesPlanFields || returnOverTotalBudget ? 80 : 5, estimatedInputTokens: mutatesPlanFields ? 800_000 : 40_000, explanatoryNote: "safe unknown field" },
                { title: "Add B", objective: mutatesPlanFields ? "Unrelated rewritten objective B" : "Add B", dependsOn: returnSerialChain ? ["0"] : [], allowedPaths: ["src/b.ts"], acceptanceCriterionIds: ["c2"], requiredArtifactIds: returnSerialChain ? ["api-contract"] : [], estimatedArkApiTurns: mutatesPlanFields || returnOverTotalBudget ? 80 : 5, estimatedInputTokens: mutatesPlanFields ? 800_000 : 40_000 },
              ],
        });
      } else if (request.prompt.includes("Produce a read-only worker preflight")) {
        const isA = request.prompt.includes("Task: Add A");
        const shouldReject = badPreflightOnce && !request.prompt.includes("previous preflight was rejected") && !rejectedPreflights.has(request.taskId ?? "global");
        if (shouldReject) rejectedPreflights.add(request.taskId ?? "global");
        output = JSON.stringify({
          understanding: isA ? "Add A" : "Add B",
          expectedFiles: [shouldReject ? "package-boundary/mapped-file1" : isA ? "src/a.ts" : "src/b.ts"],
          consumedArtifacts: [],
          publishedArtifacts: isA ? ["api-contract"] : [],
          approach: ["Implement module"], missingContext: [], plannedChecks: ["typecheck"],
        });
      } else if (request.prompt.includes("A big-model supervisor is asking you to repair")) {
        const isA = request.prompt.includes("Add A");
        await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
        await writeFile(
          path.join(request.workspacePath, isA ? "src/a.ts" : "src/b.ts"),
          isA ? "export const a = 11;\n" : "export const b = 22;\n",
        );
        recoveryApplied = true;
        output = "Applied supervisor-directed worker repair";
      } else if (request.prompt.includes("Apply the supervisor's integration recovery instructions")) {
        await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
        await writeFile(path.join(request.workspacePath, "src", "a.ts"), "export const a = 12;\n");
        recoveryApplied = true;
        output = "Applied supervisor-directed integration repair";
      } else if (request.prompt.includes("Resume the confirmed Direct execution as the same big-model executor")) {
        await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
        await writeFile(path.join(request.workspacePath, "src", "a.ts"), "export const a = 13;\n");
        recoveryApplied = true;
        output = "Applied big-model Direct recovery";
      } else if (request.prompt.includes("Implement only this confirmed task")) {
        const isA = request.prompt.includes("Task: Add A");
        if (!isA && workerConcurrencyProbe) {
          workerConcurrencyProbe.sawPredecessorOutput = await readFile(
            path.join(request.workspacePath, "src/a.ts"),
            "utf8",
          ).then(() => true).catch(() => false);
        }
        let gracefulCheckpointThisCall = false;
        if (firstWorkerGracefulCheckpoint && isA && !workerGracefulCheckpointRaised) {
          workerGracefulCheckpointRaised = true;
          gracefulCheckpointThisCall = true;
          await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
          await writeFile(path.join(request.workspacePath, "src/a.ts"), "export const a = 0;\n");
          output = JSON.stringify({
            summary: "Saved the first coherent implementation milestone",
            diagnosis: "",
            completed: false,
            remainingWork: "Finish module A and return the final artifact",
            artifacts: [],
          });
        } else if (firstWorkerBudgetBoundary && isA && !workerBudgetBoundaryRaised) {
          workerBudgetBoundaryRaised = true;
          await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
          await writeFile(path.join(request.workspacePath, "src/a.ts"), "export const a = 0;\n");
          throw new RunnerExecutionError(
            "Per-execution input-token limit exceeded (250000/250000)",
            {
              threadId: "heavy-worker-thread",
              usage: {
                inputTokens: 250_000,
                cachedInputTokens: 220_000,
                outputTokens: 4_000,
                arkApiTurns: 12,
                toolCalls: 12,
              },
              output: null,
            },
          );
        } else if (!failWorkers) {
          await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
          await writeFile(
            path.join(request.workspacePath, isA ? "src/a.ts" : "src/b.ts"),
            isA ? "export const a = 1;\n" : "export const b = 2;\n",
          );
          if (firstWorkerScopeViolation && isA && !workerScopeViolationRaised) {
            workerScopeViolationRaised = true;
            await mkdir(path.join(request.workspacePath, "public"), { recursive: true });
            await writeFile(
              path.join(request.workspacePath, "public/index.html"),
              "<p>unauthorized worker edit</p>\n",
            );
          }
        }
        if (!gracefulCheckpointThisCall) {
          output = JSON.stringify({
            summary: isA ? "Added A" : "Added B",
            diagnosis: failWorkers ? "implementation incomplete" : "",
            artifacts: isA
              ? [
                  { id: "api-contract", kind: "api", name: "API contract", payload: "v1" },
                  { id: "api-contract", kind: "api", name: "API contract", payload: "v2" },
                ]
              : [],
          });
        }
      } else if (request.prompt.includes("Diagnose this compact failure packet")) {
        output = JSON.stringify({ classification: "implementation-bug", outcome: "stop", reason: "Worker failed after bounded retries" });
      } else if (request.prompt.includes("Act as the big-model supervisor for a smaller implementation worker")) {
        output = JSON.stringify({
          classification: "implementation-defect",
          action: "retry-worker",
          reason: "The smaller worker should change its implementation approach",
          instructions: "Inspect the previous failure and implement the missing files before rerunning checks",
          targetTaskIds: request.taskId ? [request.taskId] : [],
          userQuestion: null,
        });
      } else if (request.prompt.includes("Act as the big-model supervisor for the configured execution roles")) {
        output = JSON.stringify({
          classification: recoveryAction === "needs-user" ? "permission-required" :
            recoveryAction === "retry-integrator" ? "integration-defect" :
              recoveryAction === "retry-verifier" ? "verification-strategy" : "implementation-defect",
          action: recoveryAction,
          reason: recoveryAction === "stop"
            ? "Protected or global verification failed; main workspace was not changed"
            : `Supervisor selected ${recoveryAction}`,
          instructions: `Use the ${recoveryAction} recovery strategy and gather fresh evidence`,
          targetTaskIds: [],
          userQuestion: recoveryAction === "needs-user"
            ? "Please grant the required permission or provide an approved alternative"
            : null,
        });
      } else if (request.prompt.includes("Execute the confirmed direct task")) {
        if (!allowNoChangeDirect) {
          await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
          await writeFile(path.join(request.workspacePath, "src", "a.ts"), "export const a = 1;\n");
          await writeFile(path.join(request.workspacePath, "src", "b.ts"), "export const b = 2;\n");
        }
        output = allowNoChangeDirect
          ? "Read-only direct execution completed"
          : "Direct execution completed";
      } else if (request.prompt.includes("Independently verify the integrated candidate")) {
        acceptanceCalls += 1;
        const acceptanceShouldFail = failAcceptance && !recoveryApplied && !(
          recoveryAction === "retry-verifier" && acceptanceCalls > 1
        );
        output = JSON.stringify({
          results: [
            { testId: "criterion-c1", status: acceptanceShouldFail ? "failed" : "passed", evidence: acceptanceShouldFail ? "Module A did not satisfy its protected behavior check" : "Inspected src/a.ts and confirmed its export" },
            { testId: "criterion-c2", status: "passed", evidence: "Inspected src/b.ts and confirmed its export" },
            { testId: "existing-regression-suite", status: "passed", evidence: "Relevant regression inspection passed" },
          ],
        });
      } else {
        output = "done";
      }
      if (probesWorker && workerConcurrencyProbe) workerConcurrencyProbe.active -= 1;
      return {
        output,
        threadId: null,
        usage: { inputTokens: 10, cachedInputTokens: 1, outputTokens: 5 },
        modelId: request.modelId,
        modelFallback: false,
      };
    },
    async cancel() { return true; },
    async isAvailable() { return true; },
  };
}

async function setup(
  failWorkers = false,
  failGlobal = false,
  badPreflightOnce = false,
  failAcceptance = false,
  includePostReleaseAcceptance = false,
  allowNoChangeDirect = false,
  recoveryAction: "retry-direct" | "retry-worker" | "retry-integrator" | "retry-verifier" | "needs-user" | "stop" = "stop",
  firstPlanAllowedPath: string | null = null,
  firstWorkerBudgetBoundary = false,
  firstPlanOversizedTask = false,
  firstWorkerGracefulCheckpoint = false,
  firstPlanSerialChain = false,
  workerConcurrencyProbe?: WorkerConcurrencyProbe,
  repairMutatesPlanFields = false,
  firstPlanOverTotalBudget = false,
  firstWorkerScopeViolation = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-driver-"));
  temporary.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "base.ts"), "export const base = true;\n");
  const visibleCheck = async (candidate: string) => {
    const hasA = await readFile(path.join(candidate, "src", "a.ts"), "utf8").then(() => true).catch(() => false);
    const hasB = await readFile(path.join(candidate, "src", "b.ts"), "utf8").then(() => true).catch(() => false);
    return {
      passed: allowNoChangeDirect || hasA || hasB,
      summary: allowNoChangeDirect || hasA || hasB
        ? "visible pass"
        : "expected task file missing",
    };
  };
  const calls: RecordedCall[] = [];
  const driver = new ContextAwareExecutionDriver({
    runner: fakeRunner(
      failWorkers,
      calls,
      badPreflightOnce,
      failAcceptance,
      includePostReleaseAcceptance,
      allowNoChangeDirect,
      recoveryAction,
      firstPlanAllowedPath,
      firstWorkerBudgetBoundary,
      firstPlanOversizedTask,
      firstWorkerGracefulCheckpoint,
      firstPlanSerialChain,
      workerConcurrencyProbe,
      repairMutatesPlanFields,
      firstPlanOverTotalBudget,
      firstWorkerScopeViolation,
    ),
    models: { planner: "strong", worker: "cheap", verifier: "verify", integrator: "strong" },
    runtimeHomeRoot: path.join(root, "homes"), tempRoot: path.join(root, "temp"),
    archiveRoot: path.join(root, "archive"), protectedEvaluatorRoot: path.join(root, "protected"),
    cleanupPolicy: "clean",
    verificationChecks: [
      { id: "visible", description: "visible task check", scope: "worker-visible", run: visibleCheck },
      { id: "protected", description: "protected acceptance", scope: "protected", run: async (candidate) => ({ passed: allowNoChangeDirect || await readFile(path.join(candidate, "src", "a.ts"), "utf8").then(() => true).catch(() => false), summary: "protected result" }) },
      { id: "global", description: "global regression", scope: "global", run: async (candidate) => ({ passed: !failGlobal && (allowNoChangeDirect || await readFile(path.join(candidate, "src", "b.ts"), "utf8").then(() => true).catch(() => false)), summary: failGlobal ? "controlled global failure" : "global result" }) },
    ],
  });
  return { root, workspace, driver, calls };
}

describe("ContextAwareExecutionDriver acceptance", () => {
  it("runs confirmed modular work through maps, preflights, artifacts, integration, verification, and publish", async () => {
    const { workspace, driver, calls } = await setup();
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    const elaborated = await driver.elaborateIntent({
      orchestrationId: item.id, agentId: item.agentId, prompt: item.prompt,
      requestedMode: item.requestedMode, budget: item.budget, workspacePath: workspace,
    }, sink, signal);
    expect(elaborated.draft.goal).toBe("Add two modules");
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    expect(plan.selectedMode).toBe("multi-worker");
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src", "a.ts"), "utf8")).toContain("a = 1");
    expect(await readFile(path.join(workspace, "src", "b.ts"), "utf8")).toContain("b = 2");
    expect(sink.maps.map((map) => map.version)).toEqual([1, 2]);
    expect(sink.packets.length).toBeGreaterThanOrEqual(2);
    const testPlanArtifacts = sink.artifacts.filter((artifact) =>
      artifact.name.startsWith("Contract acceptance test:"),
    );
    expect(testPlanArtifacts).toHaveLength(3);
    expect(testPlanArtifacts[0]).toMatchObject({
      kind: "decision",
      producerTaskId: "control-plane",
    });
    expect(
      sink.artifacts
        .filter((artifact) => artifact.id === "api-contract")
        .map((artifact) => artifact.version),
    ).toEqual([1, 2]);
    expect(sink.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["route-decision", "preflight-reviewed", "integration-candidate", "verified-publish"]),
    );
    expect(sink.verifications.map((record) => record.scope)).toEqual(
      expect.arrayContaining(["worker-visible", "protected", "global"]),
    );
    expect(sink.verifications.map((record) => record.commandOrCheck)).toEqual(
      expect.arrayContaining(["Verify: A works", "Verify: B works", "Existing regression suite remains healthy"]),
    );
    expect(
      sink.verifications.find((record) => record.commandOrCheck === "Existing regression suite remains healthy"),
    ).toMatchObject({
      status: "skipped",
      outputSummary: expect.stringContaining("starting workspace had no existing"),
    });
    expect(sink.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "acceptance-plan-created", actorRole: "control-plane", modelId: null }),
      expect.objectContaining({ type: "acceptance-verification-completed", actorRole: "verifier", modelId: "verify" }),
    ]));
    expect(calls.filter((call) => call.role === "worker" && call.sandboxMode === "workspace-write"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ prompt: expect.stringContaining("Relevant confirmed acceptance criteria") }),
      ]));
    expect(calls.filter((call) => call.role === "worker").map((call) => call.prompt).join("\n"))
      .not.toContain("Inspect the integrated candidate");
    expect(calls.filter((call) => call.role === "verifier")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sandboxMode: "read-only",
          runtimeProfile: "verification",
          prompt: expect.stringContaining("bundled Chromium"),
        }),
      ]),
    );
    for (const task of plan.tasks) {
      const taskCalls = calls.filter((call) => call.taskId === task.id);
      expect(taskCalls.findIndex((call) => call.sandboxMode === "read-only"))
        .toBeLessThan(taskCalls.findIndex((call) => call.sandboxMode === "workspace-write"));
    }
  });

  it("sanitizes an out-of-scope worker edit before checkpointing and retries from the clean workspace", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", null,
      false, false, false, false, undefined, false, false, true,
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, new AbortController().signal);

    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src/a.ts"), "utf8")).toContain("a = 1");
    await expect(readFile(path.join(workspace, "public/index.html"), "utf8")).rejects.toThrow();
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "worker-scope-sanitized",
      summary: expect.stringContaining("Removed unauthorized worker changes"),
    }));
    expect(sink.attempts).toContainEqual(expect.objectContaining({
      status: "failed",
      changedFiles: ["src/a.ts"],
      errorSummary: expect.stringContaining("Worker scope violation: public/index.html"),
      checkpointed: true,
    }));
    expect(
      calls.filter((call) =>
        call.sandboxMode === "workspace-write" &&
        call.prompt.includes("Task: Add A"),
      ),
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ allowedWritePaths: ["src/a.ts"] }),
    ]));
  });

  it("executes distinct dependency-ready workers concurrently", async () => {
    const probe: WorkerConcurrencyProbe = { active: 0, maximumActive: 0, startedTaskIds: [] };
    const { workspace, driver } = await setup(
      false, false, false, false, false, false, "stop", null,
      false, false, false, false, probe,
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    expect(plan.selectedMode).toBe("multi-worker");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "route-decision",
      metadata: expect.objectContaining({ maximumParallelWorkers: 2 }),
    }));

    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, new AbortController().signal);

    expect(outcome.kind).toBe("completed");
    expect(probe.maximumActive).toBe(2);
    expect(new Set(probe.startedTaskIds).size).toBe(2);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "worker-batch-started",
      summary: "Started 2 independent workers in parallel",
      metadata: expect.objectContaining({ workerCount: 2, parallel: true }),
    }));
  });

  it("accepts an efficient serial multi-worker plan without forcing parallelism", async () => {
    const probe: WorkerConcurrencyProbe = { active: 0, maximumActive: 0, startedTaskIds: [] };
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", null,
      false, false, false, true, probe,
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    expect(plan.selectedMode).toBe("multi-worker");
    expect(plan.tasks[1]?.dependsOn).toEqual([plan.tasks[0]!.id]);
    const plannerCalls = calls.filter((call) => call.role === "planner");
    expect(plannerCalls).toHaveLength(1);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "route-decision",
      metadata: expect.objectContaining({ maximumParallelWorkers: 1 }),
    }));

    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, new AbortController().signal);
    expect(outcome.kind).toBe("completed");
    expect(probe.maximumActive).toBe(1);
    expect(probe.sawPredecessorOutput).toBe(true);
  });

  it("continues a token-limited worker from its checkpoint in a fresh Codex thread", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", null, true,
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    item.budget.maxWorkerAttempts = 1;
    const signal = new AbortController().signal;
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, signal);
    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, signal);

    expect(outcome.kind).toBe("completed");
    const taskA = plan.tasks.find((task) => task.title === "Add A")!;
    const workerCalls = calls.filter((call) =>
      call.taskId === taskA.id && call.prompt.includes("Implement only this confirmed task")
    );
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[0]?.threadId ?? null).toBeNull();
    expect(workerCalls[1]?.threadId ?? null).toBeNull();
    expect(workerCalls[1]?.prompt).toContain("Checkpointed workspace summary");
    expect(workerCalls[1]?.prompt).toContain("Task: Add A");
    expect(sink.attempts).toContainEqual(expect.objectContaining({
      taskId: taskA.id,
      status: "checkpointed",
      usage: expect.objectContaining({ inputTokens: 250_000 }),
    }));
    expect(sink.attempts.filter((attempt) => attempt.taskId === taskA.id).map((attempt) => attempt.number))
      .toEqual([1, 1, 1, 1]);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "worker-compact-continuation",
      metadata: expect.objectContaining({
        resumesThread: false,
        budgetBoundary: true,
      }),
    }));
  });

  it("accepts a graceful worker checkpoint as a continuation segment instead of a failed retry", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", null, false, false, true,
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    item.budget.maxWorkerAttempts = 1;
    const signal = new AbortController().signal;
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, signal);
    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, signal);

    expect(outcome.kind).toBe("completed");
    const taskA = plan.tasks.find((task) => task.title === "Add A")!;
    const workerCalls = calls.filter((call) =>
      call.taskId === taskA.id && call.prompt.includes("Implement only this confirmed task")
    );
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]?.threadId ?? null).toBeNull();
    expect(sink.attempts).toContainEqual(expect.objectContaining({
      taskId: taskA.id,
      status: "checkpointed",
      errorSummary: null,
    }));
    expect(sink.attempts.filter((attempt) => attempt.taskId === taskA.id).map((attempt) => attempt.number))
      .toEqual([1, 1, 1, 1]);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "worker-compact-continuation",
      metadata: expect.objectContaining({
        resumesThread: false,
        graceful: true,
      }),
    }));
  });

  it("plans against the model calls remaining after prior planning usage", async () => {
    const { workspace, driver, calls } = await setup();
    const sink = new Sink();
    const item = orchestration(workspace);
    item.usage.byRole.planner = {
      modelId: "strong",
      inputTokens: 1_000,
      cachedInputTokens: 500,
      outputTokens: 250,
      estimatedUsd: null,
      modelCalls: 3,
    };

    await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    const planningCall = calls.find((call) =>
      call.role === "planner" && call.prompt.includes("Create the most execution-efficient correct coding task graph")
    );
    expect(planningCall?.prompt).toContain("Total model-call budget: 100");
    expect(planningCall?.prompt).toContain(
      "Model calls already consumed before this planning response: 3",
    );
    expect(planningCall?.prompt).toContain(
      "Maximum future model calls this plan may estimate: 95",
    );
    expect(planningCall?.prompt).toContain("Return estimatedCalls no greater than 95");
    expect(planningCall?.prompt).toContain('"estimatedCalls"');
    expect(planningCall?.prompt).toContain('"maximum":95');
    expect(planningCall?.prompt).toContain("Parallelism is enabled, never forced");
    expect(planningCall?.prompt).not.toContain("acceptanceTests");
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "route-decision",
      metadata: expect.objectContaining({
        estimatedCalls: 8,
        availableExecutionModelCalls: 95,
        alreadyConsumedModelCalls: 3,
        reservedPlanningModelCalls: 2,
      }),
    }));
  });

  it("allows safe environment templates and repairs a genuinely unsafe planner path once", async () => {
    const safeSetup = await setup(
      false, false, false, false, false, false, "stop", ".env.example",
    );
    const safeSink = new Sink();
    const safePlan = await safeSetup.driver.plan({
      orchestration: orchestration(safeSetup.workspace),
      contract: contract(),
      workspacePath: safeSetup.workspace,
    }, safeSink, new AbortController().signal);
    expect(safePlan.tasks.flatMap((task) => task.allowedPaths)).toContain(".env.example");
    expect(
      safeSetup.calls.filter((call) => call.role === "planner"),
    ).toHaveLength(1);
    expect(safeSetup.calls[0]?.prompt).toContain(
      "Non-secret templates named exactly .env.example, .env.sample, or .env.template are allowed",
    );

    const repairedSetup = await setup(
      false, false, false, false, false, false, "stop", "apps/server/.env.production",
    );
    const repairedSink = new Sink();
    const repairedPlan = await repairedSetup.driver.plan({
      orchestration: orchestration(repairedSetup.workspace),
      contract: contract(),
      workspacePath: repairedSetup.workspace,
    }, repairedSink, new AbortController().signal);
    expect(repairedPlan.tasks.flatMap((task) => task.allowedPaths))
      .not.toContain("apps/server/.env.production");
    const plannerCalls = repairedSetup.calls.filter((call) => call.role === "planner");
    expect(plannerCalls).toHaveLength(2);
    expect(plannerCalls[1]?.prompt).toContain("Protected environment files are not allowed");
    expect(plannerCalls[1]?.prompt).toContain("Invalid output to repair");
  });

  it("accepts overlapping write scopes once and serializes only the conflicting workers", async () => {
    const probe: WorkerConcurrencyProbe = { active: 0, maximumActive: 0, startedTaskIds: [] };
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", "src",
      false, false, false, false, probe,
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    expect(plan.selectedMode).toBe("multi-worker");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks.map((task) => task.title)).toEqual(["Add A", "Add B"]);
    expect(plan.tasks.some((task) => task.title === "Focused combined worker")).toBe(false);
    expect(plan.tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
    const plannerCalls = calls.filter((call) => call.role === "planner");
    expect(plannerCalls).toHaveLength(1);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "route-decision",
      metadata: expect.objectContaining({ maximumParallelWorkers: 1 }),
    }));

    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, new AbortController().signal);
    expect(outcome.kind).toBe("completed");
    expect(probe.maximumActive).toBe(1);
    expect(probe.sawPredecessorOutput).toBe(true);
  });

  it("keeps the planner's valid overlapping ownership without a repair pass", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", "src",
    );
    const sink = new Sink();
    const plan = await driver.plan({
      orchestration: orchestration(workspace),
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    expect(plan.tasks.map((task) => task.objective)).toEqual(["Add A", "Add B"]);
    expect(plan.tasks.flatMap((task) => task.allowedPaths)).toEqual(["src", "src/b.ts"]);
    expect(calls.filter((call) => call.role === "planner")).toHaveLength(1);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "route-decision",
      metadata: expect.objectContaining({
        estimatedArkApiTurns: 14,
        availableExecutionArkApiTurns: 146,
      }),
    }));
  });

  it("reports exact deterministic arithmetic when task estimates exceed the available Ark budget", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", null,
      false, false, false, false, undefined, false, true,
    );
    const sink = new Sink();
    const plan = await driver.plan({
      orchestration: orchestration(workspace),
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    expect(plan.tasks).toHaveLength(2);
    const plannerCalls = calls.filter((call) => call.role === "planner");
    expect(plannerCalls).toHaveLength(2);
    expect(plannerCalls[1]?.prompt).toContain(
      "Task estimates total 160 Ark turns; with the 4-turn verification/recovery reserve, 164 are required but only 146 are available.",
    );
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "route-decision",
      metadata: expect.objectContaining({ estimatedArkApiTurns: 14 }),
    }));
  });

  it("repairs a task that cannot fit within its bounded continuation capacity", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, false, false, false, "stop", null, false, true,
    );
    const sink = new Sink();
    const plan = await driver.plan({
      orchestration: orchestration(workspace),
      contract: contract(),
      workspacePath: workspace,
    }, sink, new AbortController().signal);

    expect(plan.selectedMode).toBe("multi-worker");
    expect(plan.tasks.map((task) => task.title)).toEqual(["Add A", "Add B"]);
    const plannerCalls = calls.filter((call) => call.role === "planner");
    expect(plannerCalls).toHaveLength(2);
    expect(plannerCalls[1]?.prompt).toContain("Split it into bounded tasks");
    expect(plannerCalls[1]?.prompt).toContain("3000000 cumulative input tokens");
  });

  it("defers post-release effects without sending them to the release verifier", async () => {
    const { workspace, driver, calls } = await setup();
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    const postReleaseContract = contract();
    postReleaseContract.criteria.push({
      id: "c3",
      kind: "functional",
      description: "User receives the final reply",
      verification: "visible-test",
    });
    const plan = await driver.plan({
      orchestration: item,
      contract: postReleaseContract,
      workspacePath: workspace,
    }, sink, signal);

    const outcome = await driver.execute({
      orchestration: item,
      contract: postReleaseContract,
      workspacePath: workspace,
      plan,
    }, sink, signal);

    expect(outcome.kind).toBe("completed");
    expect(
      calls
        .filter((call) => call.role === "verifier")
        .map((call) => call.prompt)
        .join("\n"),
    ).not.toContain("criterion-c3");
    expect(
      sink.verifications.find((record) => record.commandOrCheck === "Verify: User receives the final reply"),
    ).toMatchObject({
      status: "skipped",
      outputSummary: expect.stringContaining("Deferred until after verified publication"),
    });
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "acceptance-verification-completed",
      metadata: expect.objectContaining({ deferredPostRelease: 1 }),
    }));
  });

  it("bounds repeated failure, emits compact escalation, and never publishes", async () => {
    const { workspace, driver, calls } = await setup(true);
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    const before = await readFile(path.join(workspace, "src", "base.ts"), "utf8");
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome).toEqual({ kind: "failed", reason: "Worker failed after bounded retries" });
    expect(sink.attempts.filter((attempt) => attempt.status === "failed")).toHaveLength(4);
    expect(new Set(sink.attempts.map((attempt) => attempt.taskId)).size).toBe(2);
    expect(sink.events.some((event) => event.type === "worker-supervisor-decision")).toBe(true);
    expect(
      calls.filter((call) => call.role === "worker").at(-1)?.prompt,
    ).toContain("Big-model supervisor guidance");
    expect(sink.events.some((event) => event.type === "failure-escalation")).toBe(true);
    expect(await readFile(path.join(workspace, "src", "base.ts"), "utf8")).toBe(before);
    await expect(readFile(path.join(workspace, "src", "a.ts"))).rejects.toThrow();
    expect(sink.events.some((event) => event.type === "verified-publish")).toBe(false);
  });

  it("uses deterministic bounded preflight without spending worker model calls", async () => {
    const { workspace, driver, calls } = await setup(false, false, true);
    const sink = new Sink();
    const item = orchestration(workspace);
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome.kind).toBe("completed");
    expect(sink.events.some((event) => event.type === "preflight-reviewed" && event.metadata.deterministic === true)).toBe(true);
    const modelPreflights = calls.filter((call) => call.prompt.includes("Produce a read-only worker preflight"));
    expect(modelPreflights).toHaveLength(0);
    expect(calls.filter((call) => call.sandboxMode === "workspace-write").length).toBeGreaterThanOrEqual(plan.tasks.length);
  });

  it("blocks publication when trusted global verification fails", async () => {
    const { workspace, driver } = await setup(false, true);
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "Protected or global verification failed; main workspace was not changed",
    });
    await expect(readFile(path.join(workspace, "src", "a.ts"))).rejects.toThrow();
    await expect(readFile(path.join(workspace, "src", "b.ts"))).rejects.toThrow();
    expect(sink.verifications.find((record) => record.scope === "global")?.status).toBe("failed");
  });

  it("blocks publication when the big verifier fails a contract-derived acceptance test", async () => {
    const { workspace, driver } = await setup(false, false, false, true);
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "Protected or global verification failed; main workspace was not changed",
    });
    expect(sink.verifications.find((record) => record.commandOrCheck === "Verify: A works")?.status)
      .toBe("failed");
    await expect(readFile(path.join(workspace, "src", "a.ts"))).rejects.toThrow();
    expect(sink.events.some((event) => event.type === "verified-publish")).toBe(false);
  });

  it("lets the big supervisor send failed verification back to smaller workers", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, true, false, false, "retry-worker",
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);

    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);

    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src", "a.ts"), "utf8")).toContain("a = 11");
    expect(calls.some((call) => call.role === "worker" && call.prompt.includes("repair a failed integrated verification"))).toBe(true);
    expect(sink.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "supervisor-recovery-decision", metadata: expect.objectContaining({ action: "retry-worker" }) }),
      expect.objectContaining({ type: "recovery-worker-completed" }),
      expect.objectContaining({ type: "verified-publish" }),
    ]));
  });

  it("lets the big supervisor redirect integration and then reverifies", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, true, false, false, "retry-integrator",
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);

    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);

    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src", "a.ts"), "utf8")).toContain("a = 12");
    expect(calls.some((call) => call.role === "integrator" && call.sandboxMode === "workspace-write")).toBe(true);
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "recovery-integrator-completed" }));
  });

  it("lets the big supervisor give the verifier a different evidence strategy", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, true, false, false, "retry-verifier",
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);

    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);

    expect(outcome.kind).toBe("completed");
    expect(
      calls.filter((call) => call.role === "verifier").at(-1)?.prompt,
    ).toContain("Big-model supervisor instructions");
    expect(sink.events.filter((event) => event.type === "acceptance-verification-completed")).toHaveLength(2);
  });

  it("raises permission-dependent recovery to the user with a concrete question", async () => {
    const { workspace, driver } = await setup(
      false, false, false, true, false, false, "needs-user",
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);

    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);

    expect(outcome.kind).toBe("needs-user");
    if (outcome.kind !== "needs-user") throw new Error("Expected needs-user outcome");
    expect(outcome.amendment.reason).toContain("needs-user");
    expect(outcome.amendment.proposedIntent.materialQuestions).toEqual([
      "Please grant the required permission or provide an approved alternative",
    ]);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "supervisor-recovery-decision",
      metadata: expect.objectContaining({ action: "needs-user" }),
    }));
    expect(sink.events.some((event) => event.type === "verified-publish")).toBe(false);
  });

  it("keeps Direct recovery on the big executor even if the supervisor requests a worker", async () => {
    const { workspace, driver, calls } = await setup(
      false, false, false, true, false, false, "retry-worker",
    );
    const sink = new Sink();
    const item = orchestration(workspace);
    item.requestedMode = "direct";
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    expect(plan.selectedMode).toBe("direct");

    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);

    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src", "a.ts"), "utf8")).toContain("a = 13");
    expect(calls.some((call) => call.role === "worker")).toBe(false);
    expect(calls.some((call) =>
      call.role === "planner" &&
      call.sandboxMode === "workspace-write" &&
      call.prompt.includes("same big-model executor")
    )).toBe(true);
    expect(sink.events).toContainEqual(expect.objectContaining({
      type: "supervisor-recovery-decision",
      metadata: expect.objectContaining({ action: "retry-direct", requestedAction: "retry-worker" }),
    }));
    expect(sink.events).toContainEqual(expect.objectContaining({ type: "recovery-direct-completed" }));
  });

  it("keeps direct execution real, budgeted, verified, and published", async () => {
    const { workspace, driver } = await setup();
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    item.requestedMode = "direct";
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    expect(plan.selectedMode).toBe("direct");
    expect(plan.tasks).toHaveLength(1);
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src", "a.ts"), "utf8")).toContain("a = 1");
    expect(sink.events.some((event) => event.type === "verified-publish")).toBe(true);
  });

  it("allows verified direct execution to complete without workspace changes", async () => {
    const { workspace, driver } = await setup(false, false, false, false, false, true);
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    item.requestedMode = "direct";
    const before = await readFile(path.join(workspace, "src", "base.ts"), "utf8");
    const plan = await driver.plan({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
    }, sink, signal);

    const outcome = await driver.execute({
      orchestration: item,
      contract: contract(),
      workspacePath: workspace,
      plan,
    }, sink, signal);

    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "src", "base.ts"), "utf8")).toBe(before);
    await expect(readFile(path.join(workspace, "src", "a.ts"))).rejects.toThrow();
    expect(sink.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "direct-no-workspace-change" }),
      expect.objectContaining({ type: "verified-publish", metadata: { fileCount: 0, applicationMapVersion: 2 } }),
    ]));
  });
});
