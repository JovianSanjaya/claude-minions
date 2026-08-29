import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApplicationMapSummary,
  BudgetDecision,
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
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import { ContextAwareExecutionDriver } from "./driver.js";
import type {
  VerificationExecutionResult,
  VerificationExecutor,
} from "./verification.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemorySink implements OrchestrationSink {
  readonly events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  readonly tasks = new Map<string, OrchestrationTask>();
  readonly maps: ApplicationMapSummary[] = [];
  readonly contexts: ContextPacketSummary[] = [];
  readonly attempts: WorkerAttempt[] = [];
  readonly artifacts: SharedArtifact[] = [];
  readonly verifications: VerificationRecord[] = [];
  readonly usage: TokenUsage[] = [];
  calls = 0;

  constructor(private readonly denyAfterCalls = Number.POSITIVE_INFINITY) {}

  async reserveModelCall(_input: ModelCallReservation): Promise<BudgetDecision> {
    this.calls += 1;
    return this.calls > this.denyAfterCalls
      ? { allowed: false, reason: "Hard model-call budget exhausted" }
      : { allowed: true, reservationId: `reservation-${this.calls}` };
  }
  async commitModelUsage(_reservationId: string, actual: TokenUsage): Promise<void> {
    this.usage.push(actual);
  }
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {
    this.events.push(structuredClone(event));
  }
  async upsertTask(task: OrchestrationTask): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }
  async recordApplicationMap(map: ApplicationMapSummary): Promise<void> {
    this.maps.push(structuredClone(map));
  }
  async recordContextPacket(packet: ContextPacketSummary): Promise<void> {
    this.contexts.push(structuredClone(packet));
  }
  async recordAttempt(attempt: WorkerAttempt): Promise<void> {
    this.attempts.push(structuredClone(attempt));
  }
  async publishArtifact(artifact: SharedArtifact): Promise<void> {
    this.artifacts.push(structuredClone(artifact));
  }
  async recordVerification(record: VerificationRecord): Promise<void> {
    this.verifications.push(structuredClone(record));
  }
}

class FakeVerifier implements VerificationExecutor {
  constructor(private readonly failedCommand: string | null = null) {}
  async execute(input: { command: string }): Promise<VerificationExecutionResult> {
    const failed = input.command === this.failedCommand;
    return { exitCode: failed ? 1 : 0, stdout: failed ? "" : "passed", stderr: failed ? "controlled failure" : "" };
  }
}

class ScenarioRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  readonly cancelled: string[] = [];

  constructor(private readonly scenario: "success" | "failure" | "global-failure") {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    let output: string;
    if (request.prompt.includes("Elaborate the user's coding intent")) {
      output = JSON.stringify({
        goal: "Update backend and frontend modules",
        requirements: ["Update both modules"],
        assumptions: ["Existing interfaces remain compatible"],
        nonGoals: ["No deployment changes"],
        architectureDecisions: ["Publish a versioned API artifact"],
        materialQuestions: [],
        manualExpectations: [],
        estimate: {
          inputTokenLow: 1_000,
          inputTokenHigh: 5_000,
          outputTokenLow: 500,
          outputTokenHigh: 2_000,
          estimatedUsdLow: null,
          estimatedUsdHigh: null,
          assumptions: ["Two focused workers"],
        },
      });
    } else if (request.prompt.includes("Create a detailed implementation decomposition")) {
      output = JSON.stringify({
        tasks: [
          {
            key: "backend",
            title: "Backend",
            objective: "Update backend and publish API contract",
            dependsOn: [],
            allowedPaths: ["backend/api.ts"],
            acceptanceCriterionIds: ["functional"],
            requiredArtifactIds: [],
          },
          {
            key: "frontend",
            title: "Frontend",
            objective: "Consume API contract in frontend",
            dependsOn: ["backend"],
            allowedPaths: ["frontend/page.ts"],
            acceptanceCriterionIds: ["protected"],
            requiredArtifactIds: ["api-contract"],
          },
        ],
      });
    } else if (request.prompt.includes("Perform a read-only preflight")) {
      output = JSON.stringify({
        understanding: "Implement the assigned module only",
        expectedFiles: [request.taskId?.includes("backend") ? "backend/api.ts" : "frontend/page.ts"],
        interfacesToConsume: [],
        artifactsToPublish: request.taskId?.includes("backend") ? ["api-contract"] : [],
        approach: ["Edit the allocated file", "Run visible checks"],
        missingContext: [],
        plannedChecks: ["visible-check"],
      });
    } else if (request.prompt.includes("Review this worker preflight")) {
      output = JSON.stringify({ decision: "approve", reason: "Preflight matches contract and scope", expansionPath: null });
    } else if (request.prompt.includes("Execute the approved coding subtask")) {
      if (request.sandboxMode !== "workspace-write") throw new Error("Writable call expected");
      if (request.taskId?.includes("backend")) {
        await writeFile(path.join(request.workspacePath, "backend", "api.ts"), "export const apiVersion = 2;\n");
        output = JSON.stringify({
          summary: "Backend updated",
          diagnosis: this.scenario === "failure" ? "Implementation remains incompatible" : "",
          artifacts: [{ id: "api-contract", kind: "api", name: "API contract", payload: "apiVersion:number" }],
        });
      } else {
        await writeFile(path.join(request.workspacePath, "frontend", "page.ts"), "export const consumedVersion = 2;\n");
        output = JSON.stringify({ summary: "Frontend updated", diagnosis: "", artifacts: [] });
      }
    } else if (request.prompt.includes("Classify this compact bounded failure packet")) {
      output = JSON.stringify({ classification: "implementation-bug", action: "stop", reason: "Bounded attempts exhausted" });
    } else {
      throw new Error(`Unexpected model prompt: ${request.prompt.slice(0, 120)}`);
    }
    return {
      output,
      threadId: null,
      usage: { inputTokens: 20, cachedInputTokens: 2, outputTokens: 10 },
      modelId: request.modelId ?? "base-model",
      modelFallback: request.modelId === undefined,
    };
  }

  async cancel(executionId: string): Promise<boolean> {
    this.cancelled.push(executionId);
    return true;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function orchestration(contract: ExecutionContract): Orchestration {
  const timestamp = new Date().toISOString();
  return {
    id: "orch",
    agentId: "agent",
    prompt: "Update backend and frontend",
    requestedMode: "orchestrated",
    selectedMode: null,
    status: "ready",
    currentIntentDraftId: contract.intent.id,
    activeContractId: contract.id,
    estimate: null,
    budget: {
      maxInputTokens: 100_000,
      maxOutputTokens: 50_000,
      maxEstimatedUsd: null,
      maxModelCalls: 50,
      maxSteps: 100,
      maxWorkerAttempts: 2,
      maxContextExpansionsPerTask: 1,
      maxWallClockMs: 300_000,
    },
    usage: {
      byRole: {},
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedUsd: null,
      pricingStatus: "unknown",
    },
    finalOutput: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

function contract(): ExecutionContract {
  const timestamp = new Date().toISOString();
  return {
    id: "contract-v1",
    orchestrationId: "orch",
    version: 1,
    intent: {
      id: "intent-v1",
      orchestrationId: "orch",
      revision: 1,
      goal: "Update backend and frontend",
      requirements: ["Both modules pass"],
      assumptions: [],
      nonGoals: [],
      architectureDecisions: [],
      materialQuestions: [],
      manualExpectations: [],
      createdAt: timestamp,
    },
    criteria: [
      { id: "functional", kind: "functional", description: "Backend works", verification: "visible-test" },
      { id: "protected", kind: "runtime", description: "Integrated behavior passes", verification: "protected-test" },
    ],
    confirmedBy: "user",
    confirmedAt: timestamp,
    supersedesContractId: null,
  };
}

async function fixture(scenario: "success" | "failure" | "global-failure") {
  const root = await mkdtemp(path.join(tmpdir(), "engine-driver-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "backend"), { recursive: true });
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await writeFile(path.join(workspace, "backend", "api.ts"), "export const apiVersion = 1;\n");
  await writeFile(path.join(workspace, "frontend", "page.ts"), "export const consumedVersion = 1;\n");
  const runner = new ScenarioRunner(scenario);
  const checks = [
    { id: "visible", scope: "worker-visible" as const, command: "visible-check", args: [], cwd: "workspace" as const },
    { id: "protected", scope: "protected" as const, command: "protected-check", args: [], cwd: "protected-root" as const },
    { id: "global", scope: "global" as const, command: "global-check", args: [], cwd: "workspace" as const },
  ];
  const driver = new ContextAwareExecutionDriver({
    runner,
    models: { planner: "strong", worker: "cheap", verifier: "verify", integrator: "strong" },
    baseModelId: "base-model",
    modelOverrideSupported: true,
    runtimeHomeRoot: path.join(root, "runtime-homes"),
    tempWorkspaceRoot: path.join(root, "temp"),
    archiveWorkspaceRoot: path.join(root, "archive"),
    protectedEvaluatorRoot: path.join(root, "protected"),
    verificationChecks: checks,
    verificationExecutor: new FakeVerifier(
      scenario === "failure"
        ? "visible-check"
        : scenario === "global-failure"
          ? "global-check"
          : null,
    ),
    failureWorkspacePolicy: "clean",
    idProvider: (() => {
      let next = 0;
      return () => `id-${++next}`;
    })(),
  });
  return { root, workspace, runner, driver };
}

describe("context-aware execution driver", () => {
  it("runs the complete multi-worker, drift-refresh, verified-publication path", async () => {
    const { workspace, runner, driver } = await fixture("success");
    const sink = new MemorySink();
    const confirmed = contract();
    const state = orchestration(confirmed);
    const intent = await driver.elaborateIntent(
      {
        orchestrationId: "intent-orch",
        agentId: "agent",
        prompt: state.prompt,
        requestedMode: "orchestrated",
        budget: state.budget,
        workspacePath: workspace,
      },
      sink,
      new AbortController().signal,
    );
    expect(intent.draft.goal).toContain("backend");
    expect(intent.estimate.pricingStatus).toBe("unknown");

    const plan = await driver.plan(
      { orchestration: state, contract: confirmed, workspacePath: workspace },
      sink,
      new AbortController().signal,
    );
    expect(plan.selectedMode).toBe("multi-worker");
    const outcome = await driver.execute(
      { orchestration: state, contract: confirmed, workspacePath: workspace, plan },
      sink,
      new AbortController().signal,
    );

    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspace, "backend", "api.ts"), "utf8")).toContain("2");
    expect(await readFile(path.join(workspace, "frontend", "page.ts"), "utf8")).toContain("2");
    expect(sink.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "route.selected",
        "preflight.approve",
        "dependency.stale",
        "dependency.refreshed",
        "integration.candidate-ready",
        "integration.published",
      ]),
    );
    expect(sink.maps.map((map) => map.version)).toContain(2);
    expect(sink.contexts.every((packet) => packet.sourceFiles.length <= 4)).toBe(true);
    expect(sink.verifications.some((record) => record.scope === "protected" && record.status === "passed")).toBe(true);
    expect(sink.verifications.some((record) => record.scope === "global" && record.status === "passed")).toBe(true);
    const firstWritableByTask = new Map<string, number>();
    runner.requests.forEach((request, index) => {
      if (request.taskId && request.sandboxMode === "workspace-write" && !firstWritableByTask.has(request.taskId)) {
        firstWritableByTask.set(request.taskId, index);
      }
    });
    for (const [taskId, index] of firstWritableByTask) {
      expect(runner.requests.slice(0, index).some((request) => request.taskId === taskId && request.sandboxMode === "read-only")).toBe(true);
    }
    expect(new Set(runner.requests.map((request) => request.executionId)).size).toBe(runner.requests.length);
  });

  it("bounds repeated failure, emits a compact escalation, and never publishes", async () => {
    const { workspace, driver } = await fixture("failure");
    const originalBackend = await readFile(path.join(workspace, "backend", "api.ts"), "utf8");
    const sink = new MemorySink();
    const confirmed = contract();
    const state = orchestration(confirmed);
    const plan = await driver.plan(
      { orchestration: state, contract: confirmed, workspacePath: workspace },
      sink,
      new AbortController().signal,
    );
    const outcome = await driver.execute(
      { orchestration: state, contract: confirmed, workspacePath: workspace, plan },
      sink,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: "failed", reason: "Bounded attempts exhausted" });
    expect(await readFile(path.join(workspace, "backend", "api.ts"), "utf8")).toBe(originalBackend);
    const completedAttempts = sink.attempts.filter((attempt) => attempt.taskId.includes("backend") && attempt.completedAt !== null);
    expect(completedAttempts).toHaveLength(2);
    expect(sink.events.some((event) => event.type === "failure.escalated")).toBe(true);
    expect(sink.events.some((event) => event.type === "integration.published")).toBe(false);
  });

  it("leaves the main workspace unchanged when trusted global verification fails", async () => {
    const { workspace, driver } = await fixture("global-failure");
    const beforeBackend = await readFile(path.join(workspace, "backend", "api.ts"), "utf8");
    const beforeFrontend = await readFile(path.join(workspace, "frontend", "page.ts"), "utf8");
    const sink = new MemorySink();
    const confirmed = contract();
    const state = orchestration(confirmed);
    const plan = await driver.plan(
      { orchestration: state, contract: confirmed, workspacePath: workspace },
      sink,
      new AbortController().signal,
    );
    const outcome = await driver.execute(
      { orchestration: state, contract: confirmed, workspacePath: workspace, plan },
      sink,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(await readFile(path.join(workspace, "backend", "api.ts"), "utf8")).toBe(beforeBackend);
    expect(await readFile(path.join(workspace, "frontend", "page.ts"), "utf8")).toBe(beforeFrontend);
    expect(sink.verifications.some((record) => record.scope === "global" && record.status === "failed")).toBe(true);
    expect(sink.events.some((event) => event.type === "integration.published")).toBe(false);
  });
});
