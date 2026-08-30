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

function orchestration(workspace: string): Orchestration {
  return {
    id: "orchestration-1", agentId: "agent-1", prompt: "Add A and B",
    requestedMode: "orchestrated", selectedMode: null, status: "planning",
    currentIntentDraftId: "intent-1", activeContractId: "contract-1",
    estimate: intent.estimate,
    budget: {
      maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxEstimatedUsd: null,
      maxModelCalls: 100, maxSteps: 100, maxWorkerAttempts: 2,
      maxContextExpansionsPerTask: 2, maxWallClockMs: 60_000,
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
  calls: Array<{ taskId: string | undefined; sandboxMode: string | undefined; runtimeProfile: string | undefined; role: string | undefined; prompt: string }> = [],
  badPreflightOnce = false,
  failAcceptance = false,
  includePostReleaseAcceptance = false,
  allowNoChangeDirect = false,
  recoveryAction: "retry-direct" | "retry-worker" | "retry-integrator" | "retry-verifier" | "needs-user" | "stop" = "stop",
  firstPlanAllowedPath: string | null = null,
): AgentRunner {
  const rejectedPreflights = new Set<string>();
  let recoveryApplied = false;
  let acceptanceCalls = 0;
  let planningResponses = 0;
  return {
    async run(request) {
      calls.push({ taskId: request.taskId, sandboxMode: request.sandboxMode, runtimeProfile: request.runtimeProfile, role: request.role, prompt: request.prompt });
      let output: string;
      if (request.prompt.includes("Elaborate the user's intent")) {
        output = JSON.stringify(intent);
      } else if (
        request.prompt.includes("Create a bounded coding plan") ||
        (firstPlanAllowedPath !== null && request.prompt.includes("Invalid output to repair"))
      ) {
        const firstTaskAllowedPath = planningResponses === 0 && firstPlanAllowedPath
          ? firstPlanAllowedPath
          : "src/a.ts";
        planningResponses += 1;
        const acceptanceTests = [
          { id: "accept-a", title: "Module A works", criterionIds: ["c1"], category: "functional", scope: "protected", procedure: "Inspect and exercise module A", expectedOutcome: "A exports the expected value" },
          { id: "accept-b", title: "Module B works", criterionIds: ["c2"], category: "functional", scope: "protected", procedure: "Inspect and exercise module B", expectedOutcome: "B exports the expected value" },
          { id: "regression", title: "Regression checks pass", criterionIds: [], category: "regression", scope: "global", procedure: "Run relevant repository checks", expectedOutcome: "Checks pass" },
        ];
        if (includePostReleaseAcceptance) {
          acceptanceTests.push({
            id: "final-reply",
            title: "User receives the final reply",
            criterionIds: [],
            category: "functional",
            scope: "global",
            procedure: "Review the agent's final response to the user",
            expectedOutcome: "The final response tells the user what was delivered",
          });
        }
        output = JSON.stringify({
          coupling: "LOW", estimatedCalls: "8", estimatedContextTokens: "1000",
          tasks: [
            { title: "Add A", objective: "Add A", dependsOn: [], allowedPaths: [firstTaskAllowedPath], acceptanceCriterionIds: ["c1"], requiredArtifactIds: [], explanatoryNote: "safe unknown field" },
            { title: "Add B", objective: "Add B", dependsOn: ["0"], allowedPaths: ["src/b.ts"], acceptanceCriterionIds: ["c2"], requiredArtifactIds: ["api-contract"] },
          ],
          acceptanceTests,
        });
      } else if (request.prompt.includes("Produce a read-only worker preflight")) {
        const isA = request.prompt.includes("Task: Add A");
        const shouldReject = badPreflightOnce && !request.prompt.includes("previous preflight was rejected") && !rejectedPreflights.has(request.taskId ?? "global");
        if (shouldReject) rejectedPreflights.add(request.taskId ?? "global");
        output = JSON.stringify({
          understanding: isA ? "Add A" : "Add B",
          expectedFiles: [shouldReject ? "package-boundary/mapped-file1" : isA ? "src/a.ts" : "src/b.ts"],
          consumedArtifacts: isA ? [] : ["api-contract"],
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
        if (!failWorkers) {
          await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
          await writeFile(
            path.join(request.workspacePath, isA ? "src/a.ts" : "src/b.ts"),
            isA ? "export const a = 1;\n" : "export const b = 2;\n",
          );
        }
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
            { testId: "accept-a", status: acceptanceShouldFail ? "failed" : "passed", evidence: acceptanceShouldFail ? "Module A did not satisfy its protected behavior check" : "Inspected src/a.ts and confirmed its export" },
            { testId: "accept-b", status: "passed", evidence: "Inspected src/b.ts and confirmed its export" },
            { testId: "regression", status: "passed", evidence: "Relevant regression inspection passed" },
          ],
        });
      } else {
        output = "done";
      }
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
  const calls: Array<{ taskId: string | undefined; sandboxMode: string | undefined; runtimeProfile: string | undefined; role: string | undefined; prompt: string }> = [];
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
      artifact.name.startsWith("Planner acceptance test:"),
    );
    expect(testPlanArtifacts).toHaveLength(3);
    expect(testPlanArtifacts[0]).toMatchObject({
      kind: "decision",
      producerTaskId: "planner",
    });
    expect(
      sink.artifacts
        .filter((artifact) => !artifact.name.startsWith("Planner acceptance test:"))
        .map((artifact) => artifact.version),
    ).toEqual([1, 2]);
    expect(sink.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["route-decision", "preflight-reviewed", "dependency-refreshed", "integration-candidate", "verified-publish"]),
    );
    expect(sink.verifications.map((record) => record.scope)).toEqual(
      expect.arrayContaining(["worker-visible", "protected", "global"]),
    );
    expect(sink.verifications.map((record) => record.commandOrCheck)).toEqual(
      expect.arrayContaining(["Module A works", "Module B works", "Regression checks pass"]),
    );
    expect(
      sink.verifications.find((record) => record.commandOrCheck === "Regression checks pass"),
    ).toMatchObject({
      status: "skipped",
      outputSummary: expect.stringContaining("starting workspace had no existing"),
    });
    expect(sink.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "acceptance-plan-created", actorRole: "planner", modelId: "strong" }),
      expect.objectContaining({ type: "acceptance-verification-completed", actorRole: "verifier", modelId: "verify" }),
    ]));
    expect(calls.filter((call) => call.role === "worker" && call.sandboxMode === "workspace-write"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ prompt: expect.stringContaining("Relevant confirmed acceptance criteria") }),
      ]));
    expect(calls.filter((call) => call.role === "worker").map((call) => call.prompt).join("\n"))
      .not.toContain("Inspect and exercise module A");
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
      call.role === "planner" && call.prompt.includes("Create a bounded coding plan")
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

  it("defers post-release effects without sending them to the release verifier", async () => {
    const { workspace, driver, calls } = await setup(false, false, false, false, true);
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
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
    expect(
      calls
        .filter((call) => call.role === "verifier")
        .map((call) => call.prompt)
        .join("\n"),
    ).not.toContain("final-reply");
    expect(
      sink.verifications.find((record) => record.commandOrCheck === "User receives the final reply"),
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
    expect(sink.attempts.filter((attempt) => attempt.status === "failed")).toHaveLength(2);
    expect(sink.events.some((event) => event.type === "worker-supervisor-decision")).toBe(true);
    expect(
      calls.filter((call) => call.role === "worker").at(-1)?.prompt,
    ).toContain("Big-model supervisor guidance");
    expect(sink.events.some((event) => event.type === "failure-escalation")).toBe(true);
    expect(await readFile(path.join(workspace, "src", "base.ts"), "utf8")).toBe(before);
    await expect(readFile(path.join(workspace, "src", "a.ts"))).rejects.toThrow();
    expect(sink.events.some((event) => event.type === "verified-publish")).toBe(false);
  });

  it("corrects one out-of-scope preflight before any writable worker call", async () => {
    const { workspace, driver, calls } = await setup(false, false, true);
    const sink = new Sink();
    const item = orchestration(workspace);
    const signal = new AbortController().signal;
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome.kind).toBe("completed");
    expect(sink.events.some((event) => event.type === "preflight-correction-requested")).toBe(true);
    for (const task of plan.tasks) {
      const taskCalls = calls.filter((call) => call.taskId === task.id);
      expect(taskCalls.filter((call) => call.sandboxMode === "read-only").length).toBeGreaterThanOrEqual(2);
      expect(taskCalls.findIndex((call) => call.sandboxMode === "workspace-write")).toBeGreaterThan(1);
    }
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

  it("blocks publication when the big verifier fails a planner-generated acceptance test", async () => {
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
    expect(sink.verifications.find((record) => record.commandOrCheck === "Module A works")?.status)
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
