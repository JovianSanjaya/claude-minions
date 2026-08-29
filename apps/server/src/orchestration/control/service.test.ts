import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ContractAmendment,
  CostEstimate,
  ExecutionOutcome,
  IntentDraft,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  PlanResult,
} from "../contracts.js";
import { OrchestrationControlService } from "./service.js";
import { OrchestrationStore } from "./store.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeDriver implements OrchestrationExecutionDriver {
  cancelled = 0;
  outcome: ExecutionOutcome = { kind: "completed", finalOutput: "published" };
  materialQuestions: string[] = [];
  blockExecution = false;

  async elaborateIntent(input: Parameters<OrchestrationExecutionDriver["elaborateIntent"]>[0]) {
    const draft: IntentDraft = {
      id: "ignored", orchestrationId: input.orchestrationId, revision: 0,
      goal: "Implement the confirmed feature", requirements: ["Feature works"],
      assumptions: ["Baseline remains stable"], nonGoals: ["No unrelated redesign"],
      architectureDecisions: ["Use the control-plane boundary"],
      materialQuestions: this.materialQuestions,
      manualExpectations: ["The result is understandable"], createdAt: "ignored",
    };
    const estimate: CostEstimate = {
      inputTokenLow: 100, inputTokenHigh: 200, outputTokenLow: 50,
      outputTokenHigh: 100, estimatedUsdLow: null, estimatedUsdHigh: null,
      pricingStatus: "unknown", assumptions: ["One planner call"],
    };
    return { draft, estimate };
  }

  async plan(input: Parameters<OrchestrationExecutionDriver["plan"]>[0]): Promise<PlanResult> {
    return {
      selectedMode: "one-worker",
      routeReason: "Focused change",
      tasks: [{
        id: randomUUID(), orchestrationId: input.orchestration.id, title: "Implement",
        objective: "Implement safely", status: "ready", dependsOn: [],
        allowedPaths: ["src/feature.ts"], acceptanceCriterionIds: input.contract.criteria.map((item) => item.id),
        requiredArtifactIds: [], observedArtifactVersions: {}, applicationMapVersion: 1,
        attemptCount: 0,
      }],
      applicationMap: {
        orchestrationId: input.orchestration.id, version: 1,
        repositoryHash: "abc", summary: "small repository", fileCount: 10,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async execute(
    _input: Parameters<OrchestrationExecutionDriver["execute"]>[0],
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    if (this.blockExecution) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ kind: "cancelled", reason: "aborted" }), { once: true });
      });
    }
    await sink.recordEvent({
      orchestrationId: _input.orchestration.id, taskId: null, executionId: "exec-1",
      type: "worker-step", actorRole: "worker", modelId: "worker-model",
      summary: "Worker completed visible checks", metadata: { safe: true },
    });
    return this.outcome;
  }

  async cancel(): Promise<boolean> {
    this.cancelled += 1;
    return true;
  }
}

async function fixture(driver = new FakeDriver(), file?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-control-service-"));
  const store = new OrchestrationStore(file ?? path.join(directory, "orchestrations.json"));
  const service = new OrchestrationControlService({
    store,
    driver,
    agentAccess: {
      getAgent: (id) => id === AGENT_ID
        ? { id, status: "ready", workspacePath: path.join(directory, "workspace") }
        : null,
    },
  });
  await service.initialize();
  return { service, store, driver, directory };
}

async function createReady(service: OrchestrationControlService) {
  const created = await service.createOrchestration(AGENT_ID, {
    prompt: "Build the feature", requestedMode: "auto",
  });
  await service.waitForIdle(created.id);
  await service.confirm(created.id);
  await service.waitForIdle(created.id);
  return created.id;
}

describe("OrchestrationControlService", () => {
  it("drives create, immutable revise, explicit confirm, plan, start, verify, and complete", async () => {
    const { service } = await fixture();
    const created = await service.createOrchestration(AGENT_ID, {
      prompt: "Build the feature", requestedMode: "auto",
    });
    await service.waitForIdle(created.id);
    expect(service.getOrchestration(created.id).orchestration.status).toBe("awaiting-confirmation");

    await service.reviseIntent(created.id, "Keep the public API stable");
    await service.waitForIdle(created.id);
    const revised = service.getOrchestration(created.id);
    expect(revised.intentHistory.map((item) => item.revision)).toEqual([1, 2]);
    expect(revised.orchestration.prompt).toBe("Build the feature");

    const contract = await service.confirm(created.id);
    await service.waitForIdle(created.id);
    const ready = service.getOrchestration(created.id);
    expect(ready.orchestration.status).toBe("ready");
    expect(ready.activeContract?.confirmedBy).toBe("user");
    expect(ready.plan?.selectedMode).toBe("one-worker");

    await service.start(created.id);
    await service.waitForIdle(created.id);
    const completed = service.getOrchestration(created.id);
    expect(completed.orchestration).toMatchObject({ status: "completed", finalOutput: "published" });
    expect(completed.contractHistory).toEqual([contract]);
    expect(completed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["intent-drafted", "contract-confirmed", "plan-ready", "integration", "verification"]),
    );
  });

  it("never plans before explicit confirmation and rejects unresolved material questions", async () => {
    const driver = new FakeDriver();
    driver.materialQuestions = ["Must the public API change?"];
    const { service } = await fixture(driver);
    const created = await service.createOrchestration(AGENT_ID, {
      prompt: "Ambiguous work", requestedMode: "orchestrated",
    });
    await service.waitForIdle(created.id);
    expect(service.getOrchestration(created.id).plan).toBeNull();
    await expect(service.confirm(created.id)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("atomically enforces one active orchestration and stopped-Agent denial", async () => {
    const { service } = await fixture();
    await service.createOrchestration(AGENT_ID, { prompt: "first", requestedMode: "auto" });
    await expect(
      service.createOrchestration(AGENT_ID, { prompt: "second", requestedMode: "auto" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-stopped-"));
    const stopped = new OrchestrationControlService({
      store: new OrchestrationStore(path.join(directory, "db.json")),
      driver: new FakeDriver(),
      agentAccess: { getAgent: (id) => ({ id, status: "stopped", workspacePath: directory }) },
    });
    await stopped.initialize();
    await expect(
      stopped.createOrchestration(AGENT_ID, { prompt: "work", requestedMode: "auto" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("persists role usage and turns reservation denial into budget-exhausted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-budget-service-"));
    const service = new OrchestrationControlService({
      store: new OrchestrationStore(path.join(directory, "db.json")),
      driver: new FakeDriver(),
      agentAccess: { getAgent: (id) => ({ id, status: "ready", workspacePath: directory }) },
      pricing: [{
        role: "planner", modelId: "planner", inputUsdPerMillion: 1,
        cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2,
      }],
    });
    await service.initialize();
    const created = await service.createOrchestration(AGENT_ID, {
      prompt: "budgeted", requestedMode: "auto", budget: { maxInputTokens: 100 },
    });
    await service.waitForIdle(created.id);
    const allowed = await service.reserveModelCall({
      orchestrationId: created.id, taskId: null, executionId: "e1", role: "planner",
      modelId: "planner", estimatedInputTokens: 50, estimatedOutputTokens: 10,
    });
    expect(allowed.allowed).toBe(true);
    if (allowed.allowed) {
      await service.commitModelUsage(allowed.reservationId, {
        inputTokens: 40, cachedInputTokens: 5, outputTokens: 8,
      });
    }
    expect(service.getOrchestration(created.id).usage.byRole.planner).toMatchObject({ modelCalls: 1 });
    const denied = await service.reserveModelCall({
      orchestrationId: created.id, taskId: null, executionId: "e2", role: "planner",
      modelId: "planner", estimatedInputTokens: 60, estimatedOutputTokens: 1,
    });
    expect(denied).toMatchObject({ allowed: false, reason: "Input-token budget exhausted" });
    expect(service.getOrchestration(created.id).orchestration.status).toBe("budget-exhausted");
  });

  it("cancels active work idempotently, calls the driver, and retains evidence", async () => {
    const driver = new FakeDriver();
    driver.blockExecution = true;
    const { service } = await fixture(driver);
    const id = await createReady(service);
    await service.start(id);
    await service.cancel(id);
    await service.waitForIdle(id);
    expect(service.getOrchestration(id).orchestration.status).toBe("cancelled");
    expect(service.getOrchestration(id).events.some((event) => event.type === "cancellation")).toBe(true);
    await service.cancel(id);
    expect(driver.cancelled).toBe(2);
  });

  it("stores a material amendment and requires renewed explicit confirmation", async () => {
    const driver = new FakeDriver();
    const { service } = await fixture(driver);
    const id = await createReady(service);
    const current = service.getOrchestration(id);
    const amendment: ContractAmendment = {
      id: randomUUID(), orchestrationId: id, baseContractId: current.activeContract!.id,
      proposedIntent: { ...current.activeDraft!, id: randomUUID(), revision: 2 },
      proposedCriteria: null, reason: "Public API must materially change", material: true,
      status: "pending", createdAt: new Date().toISOString(), decidedAt: null,
    };
    driver.outcome = { kind: "needs-user", amendment };
    await service.start(id);
    await service.waitForIdle(id);
    expect(service.getOrchestration(id).orchestration.status).toBe("needs-user");
    await service.confirmAmendment(id, amendment.id);
    await service.waitForIdle(id);
    const after = service.getOrchestration(id);
    expect(after.orchestration.status).toBe("ready");
    expect(after.contractHistory).toHaveLength(2);
    expect(after.amendments[0]?.status).toBe("confirmed");
  });

  it("reconciles interrupted execution to cancelled after restart", async () => {
    const driver = new FakeDriver();
    driver.blockExecution = true;
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-restart-"));
    const file = path.join(directory, "db.json");
    const first = await fixture(driver, file);
    const id = await createReady(first.service);
    await first.service.start(id);
    expect(first.service.getOrchestration(id).orchestration.status).toBe("running");

    const restarted = await fixture(new FakeDriver(), file);
    const reconciled = restarted.service.getOrchestration(id);
    expect(reconciled.orchestration.status).toBe("cancelled");
    expect(reconciled.events.at(-1)?.type).toBe("restart-reconciled");
    expect(reconciled.usage).toEqual(first.service.getOrchestration(id).usage);
  });
});
