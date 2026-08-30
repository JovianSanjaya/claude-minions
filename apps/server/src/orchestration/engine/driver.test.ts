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
  calls: Array<{ taskId: string | undefined; sandboxMode: string | undefined; role: string | undefined }> = [],
  badPreflightOnce = false,
): AgentRunner {
  const rejectedPreflights = new Set<string>();
  return {
    async run(request) {
      calls.push({ taskId: request.taskId, sandboxMode: request.sandboxMode, role: request.role });
      let output: string;
      if (request.prompt.includes("Elaborate the user's intent")) {
        output = JSON.stringify(intent);
      } else if (request.prompt.includes("Create a bounded coding plan")) {
        output = JSON.stringify({
          coupling: "LOW", estimatedCalls: "8", estimatedContextTokens: "1000",
          tasks: [
            { title: "Add A", objective: "Add A", dependsOn: [], allowedPaths: ["src/a.ts"], acceptanceCriterionIds: ["c1"], requiredArtifactIds: [], explanatoryNote: "safe unknown field" },
            { title: "Add B", objective: "Add B", dependsOn: ["0"], allowedPaths: ["src/b.ts"], acceptanceCriterionIds: ["c2"], requiredArtifactIds: ["api-contract"] },
          ],
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
      } else if (request.prompt.includes("Execute the confirmed direct task")) {
        await mkdir(path.join(request.workspacePath, "src"), { recursive: true });
        await writeFile(path.join(request.workspacePath, "src", "a.ts"), "export const a = 1;\n");
        await writeFile(path.join(request.workspacePath, "src", "b.ts"), "export const b = 2;\n");
        output = "Direct execution completed";
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

async function setup(failWorkers = false, failGlobal = false, badPreflightOnce = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-driver-"));
  temporary.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "base.ts"), "export const base = true;\n");
  const visibleCheck = async (candidate: string) => {
    const hasA = await readFile(path.join(candidate, "src", "a.ts"), "utf8").then(() => true).catch(() => false);
    const hasB = await readFile(path.join(candidate, "src", "b.ts"), "utf8").then(() => true).catch(() => false);
    return { passed: hasA || hasB, summary: hasA || hasB ? "visible pass" : "expected task file missing" };
  };
  const calls: Array<{ taskId: string | undefined; sandboxMode: string | undefined; role: string | undefined }> = [];
  const driver = new ContextAwareExecutionDriver({
    runner: fakeRunner(failWorkers, calls, badPreflightOnce),
    models: { planner: "strong", worker: "cheap", verifier: "verify", integrator: "strong" },
    runtimeHomeRoot: path.join(root, "homes"), tempRoot: path.join(root, "temp"),
    archiveRoot: path.join(root, "archive"), protectedEvaluatorRoot: path.join(root, "protected"),
    cleanupPolicy: "clean",
    verificationChecks: [
      { id: "visible", description: "visible task check", scope: "worker-visible", run: visibleCheck },
      { id: "protected", description: "protected acceptance", scope: "protected", run: async (candidate) => ({ passed: await readFile(path.join(candidate, "src", "a.ts"), "utf8").then(() => true).catch(() => false), summary: "protected result" }) },
      { id: "global", description: "global regression", scope: "global", run: async (candidate) => ({ passed: !failGlobal && await readFile(path.join(candidate, "src", "b.ts"), "utf8").then(() => true).catch(() => false), summary: failGlobal ? "controlled global failure" : "global result" }) },
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
    expect(sink.artifacts.map((artifact) => artifact.version)).toEqual([1, 2]);
    expect(sink.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["route-decision", "preflight-reviewed", "dependency-refreshed", "integration-candidate", "verified-publish"]),
    );
    expect(sink.verifications.map((record) => record.scope)).toEqual(
      expect.arrayContaining(["worker-visible", "protected", "global"]),
    );
    for (const task of plan.tasks) {
      const taskCalls = calls.filter((call) => call.taskId === task.id);
      expect(taskCalls.findIndex((call) => call.sandboxMode === "read-only"))
        .toBeLessThan(taskCalls.findIndex((call) => call.sandboxMode === "workspace-write"));
    }
  });

  it("bounds repeated failure, emits compact escalation, and never publishes", async () => {
    const { workspace, driver } = await setup(true);
    const sink = new Sink();
    const signal = new AbortController().signal;
    const item = orchestration(workspace);
    const plan = await driver.plan({ orchestration: item, contract: contract(), workspacePath: workspace }, sink, signal);
    const before = await readFile(path.join(workspace, "src", "base.ts"), "utf8");
    const outcome = await driver.execute({ orchestration: item, contract: contract(), workspacePath: workspace, plan }, sink, signal);
    expect(outcome).toEqual({ kind: "failed", reason: "Worker failed after bounded retries" });
    expect(sink.attempts.filter((attempt) => attempt.status === "failed")).toHaveLength(2);
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
});
