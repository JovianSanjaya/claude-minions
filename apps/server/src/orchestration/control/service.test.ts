import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApplicationMapSummary,
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionOutcome,
  IntentDraft,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  PlanInput,
  PlanResult,
} from "../contracts.js";
import type { PricingTable } from "./budget-ledger.js";
import { DEFAULT_BUDGET_POLICY } from "./budget-ledger.js";
import type {
  AgentAccessPort,
  AgentAccessSummary,
  ControlPlaneSink,
} from "./service.js";
import {
  createAgentExecutionCoordinator,
  ORCHESTRATION_EVENT_TYPES,
  OrchestrationControlService,
} from "./service.js";
import { OrchestrationStore } from "./store.js";

/* ------------------------------------------------------------------ fakes */

/**
 * Deterministic fake execution driver. Task 1 is tested entirely against this;
 * no production mock exists anywhere in `src` outside `*.test.ts`.
 */
class FakeDriver implements OrchestrationExecutionDriver {
  elaborateCount = 0;
  planCount = 0;
  executeCount = 0;
  cancelCount = 0;
  lastPrompt = "";
  materialQuestions: string[] = [];

  onElaborate:
    | ((input: ElaborateIntentInput, sink: OrchestrationSink) => Promise<{
        draft: IntentDraft;
        estimate: CostEstimate;
      }>)
    | null = null;
  onPlan: ((input: PlanInput, sink: OrchestrationSink) => Promise<PlanResult>) | null = null;
  onExecute:
    | ((
        input: ExecuteInput,
        sink: OrchestrationSink,
        signal: AbortSignal,
      ) => Promise<ExecutionOutcome>)
    | null = null;
  onCancel: (() => void) | null = null;

  async elaborateIntent(
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
  ): Promise<{ draft: IntentDraft; estimate: CostEstimate }> {
    this.elaborateCount += 1;
    this.lastPrompt = input.prompt;
    if (this.onElaborate) {
      return this.onElaborate(input, sink);
    }
    return {
      draft: {
        id: "driver-supplied-id",
        orchestrationId: input.orchestrationId,
        revision: 999,
        goal: "Add password reset, interpretation " + this.elaborateCount,
        requirements: [
          "Reset tokens expire after 30 minutes",
          "Reset emails are queued, not sent inline",
        ],
        assumptions: ["The existing user table is reused"],
        nonGoals: ["No change to single sign-on"],
        architectureDecisions: ["Store a token hash, never the raw token"],
        materialQuestions: [...this.materialQuestions],
        manualExpectations: ["The reset email copy reads clearly"],
        createdAt: "driver-supplied-timestamp",
      },
      estimate: {
        inputTokenLow: 10_000,
        inputTokenHigh: 40_000,
        outputTokenLow: 2_000,
        outputTokenHigh: 8_000,
        estimatedUsdLow: null,
        estimatedUsdHigh: null,
        pricingStatus: "unknown",
        assumptions: ["Assumes three focused workers"],
      },
    };
  }

  async plan(input: PlanInput, sink: OrchestrationSink): Promise<PlanResult> {
    this.planCount += 1;
    if (this.onPlan) {
      return this.onPlan(input, sink);
    }
    return {
      selectedMode: "multi-worker",
      routeReason: "Persistence, API and frontend work are loosely coupled",
      tasks: [makeTask("task-1"), makeTask("task-2", ["task-1"])],
      applicationMap: makeMap(input.orchestration.id),
    };
  }

  async execute(
    input: ExecuteInput,
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    this.executeCount += 1;
    if (this.onExecute) {
      return this.onExecute(input, sink, signal);
    }
    await recordSuccessfulWork(sink, input);
    return { kind: "completed", finalOutput: "Password reset implemented and verified" };
  }

  async cancel(): Promise<boolean> {
    this.cancelCount += 1;
    this.onCancel?.();
    return true;
  }
}

class FakeAgents implements AgentAccessPort {
  readonly agents = new Map<string, AgentAccessSummary>();

  async getAgent(agentId: string): Promise<AgentAccessSummary | null> {
    return this.agents.get(agentId) ?? null;
  }
}

function makeTask(id: string, dependsOn: string[] = []): OrchestrationTask {
  return {
    id,
    orchestrationId: "driver-supplied",
    title: "Task " + id,
    objective: "Implement the " + id + " slice",
    status: "ready",
    dependsOn,
    allowedPaths: ["src/" + id + "/**"],
    acceptanceCriterionIds: ["c1"],
    requiredArtifactIds: [],
    observedArtifactVersions: { "reset-token-schema": 1 },
    applicationMapVersion: 1,
    attemptCount: 0,
  };
}

function makeMap(orchestrationId: string, version = 1): ApplicationMapSummary {
  return {
    orchestrationId,
    version,
    repositoryHash: "sha256-repository-" + version,
    summary: "42 files across 6 modules",
    fileCount: 42,
    createdAt: "driver-supplied-timestamp",
  };
}

/** Emits a realistic, correlated evidence trail through the sink. */
async function recordSuccessfulWork(
  sink: OrchestrationSink,
  input: ExecuteInput,
): Promise<void> {
  const control = sink as ControlPlaneSink;
  for (const task of input.plan.tasks) {
    const reservation = await sink.reserveModelCall({
      orchestrationId: input.orchestration.id,
      taskId: task.id,
      executionId: "execution-" + task.id,
      role: "worker",
      modelId: "worker-model",
      estimatedInputTokens: 4_000,
      estimatedOutputTokens: 1_000,
    });
    if (!reservation.allowed) {
      return;
    }
    await sink.commitModelUsage(reservation.reservationId, {
      inputTokens: 3_000,
      cachedInputTokens: 500,
      outputTokens: 900,
    });
    await sink.recordContextPacket({
      taskId: task.id,
      applicationMapVersion: 1,
      contractVersion: 1,
      sourceFiles: [{ path: "src/reset.ts", sha256: "abc123", bytes: 2_048 }],
      relevantInterfaces: ["ResetTokenService"],
      artifactVersions: { "reset-token-schema": 1 },
      estimatedTokens: 1_200,
    });
    await sink.recordAttempt({
      id: "attempt-" + task.id,
      orchestrationId: input.orchestration.id,
      taskId: task.id,
      number: 1,
      executionId: "execution-" + task.id,
      modelId: "worker-model",
      contextFileHashes: ["abc123"],
      changedFiles: ["src/reset.ts"],
      status: "passed",
      usage: { inputTokens: 3_000, cachedInputTokens: 500, outputTokens: 900 },
      errorSummary: null,
      createdAt: "driver-supplied",
      completedAt: "driver-supplied",
    });
    await sink.upsertTask({ ...task, status: "passed", attemptCount: 1 });
  }

  await sink.publishArtifact({
    id: "artifact-1",
    orchestrationId: input.orchestration.id,
    producerTaskId: "task-1",
    kind: "schema",
    name: "reset-token-schema",
    version: 2,
    payload: '{"token":"hashed"}',
    createdAt: "driver-supplied",
  });
  await control.markIntegrating("Deterministic merge of two non-overlapping manifests");
  await control.markVerifying("Running protected and global checks");
  await sink.recordVerification({
    id: "verification-1",
    orchestrationId: input.orchestration.id,
    taskId: null,
    scope: "global",
    commandOrCheck: "npm run check",
    status: "passed",
    outputSummary: "all suites passed",
    startedAt: "driver-supplied",
    completedAt: "driver-supplied",
  });
  await control.recordWorkspaceDisposition({
    taskId: null,
    policy: "archived",
    location: "/tmp/orchestration-archive/run-1",
    reason: "retained for demo evidence",
  });
}

/* --------------------------------------------------------------- harness */

interface Harness {
  service: OrchestrationControlService;
  store: OrchestrationStore;
  driver: FakeDriver;
  agents: FakeAgents;
  agentId: string;
  filePath: string;
}

let directory: string;
let counter: number;

function nextId(): string {
  counter += 1;
  return "00000000-0000-4000-8000-" + String(counter).padStart(12, "0");
}

async function createHarness(
  options: { pricing?: PricingTable; budget?: Partial<typeof DEFAULT_BUDGET_POLICY> } = {},
): Promise<Harness> {
  const filePath = path.join(directory, "orchestrations-" + nextId() + ".json");
  const store = new OrchestrationStore(filePath);
  const driver = new FakeDriver();
  const agents = new FakeAgents();
  const agentId = nextId();
  agents.agents.set(agentId, {
    id: agentId,
    status: "ready",
    workspacePath: "/tmp/workspaces/" + agentId,
  });
  const service = new OrchestrationControlService({
    store,
    driver,
    agents,
    newId: nextId,
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
    ...(options.budget === undefined
      ? {}
      : { defaultBudget: { ...DEFAULT_BUDGET_POLICY, ...options.budget } }),
  });
  await service.initialize();
  return { service, store, driver, agents, agentId, filePath };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "orchestration-service-"));
  counter = 0;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function createAndDraft(harness: Harness): Promise<string> {
  const orchestration = await harness.service.createOrchestration({
    agentId: harness.agentId,
    prompt: "Add password reset to the application",
    requestedMode: "auto",
  });
  await harness.service.whenSettled(orchestration.id);
  return orchestration.id;
}

/* ----------------------------------------------------------------- tests */

describe("Task 1 acceptance journey", () => {
  it("drives create, draft, revise, confirm, plan, ready, start, verify, completed", async () => {
    const harness = await createHarness();
    const { service, driver } = harness;

    const created = await service.createOrchestration({
      agentId: harness.agentId,
      prompt: "Add password reset to the application",
      requestedMode: "orchestrated",
    });
    expect(created.status).toBe("drafting-intent");
    expect(created.estimate).toBeNull();

    await service.whenSettled(created.id);
    let model = service.getOrchestration(created.id);
    expect(model.orchestration.status).toBe("awaiting-confirmation");
    expect(model.intentDraft?.revision).toBe(1);
    expect(model.intentDraft?.requirements).toHaveLength(2);
    expect(model.intentDraft?.id).not.toBe("driver-supplied-id");
    expect(model.orchestration.estimate?.pricingStatus).toBe("unknown");
    expect(model.orchestration.estimate?.estimatedUsdLow).toBeNull();
    expect(driver.planCount).toBe(0);

    await service.reviseIntent(created.id, "Also require rate limiting on the reset endpoint");
    await service.whenSettled(created.id);
    model = service.getOrchestration(created.id);
    expect(model.orchestration.status).toBe("awaiting-confirmation");
    expect(model.intentDraft?.revision).toBe(2);
    expect(model.intentDraftHistory).toHaveLength(2);
    expect(driver.lastPrompt).toContain("rate limiting");
    expect(driver.planCount).toBe(0);

    const confirmed = await service.confirmIntent(created.id, { confirm: true });
    expect(confirmed.contract.version).toBe(1);
    expect(confirmed.contract.confirmedBy).toBe("user");
    expect(confirmed.contract.criteria.some((item) => item.kind === "functional")).toBe(true);
    expect(confirmed.contract.criteria.some((item) => item.kind === "architectural")).toBe(true);
    expect(confirmed.contract.criteria.some((item) => item.kind === "scope")).toBe(true);
    expect(confirmed.contract.criteria.some((item) => item.kind === "manual")).toBe(true);
    expect(confirmed.contract.criteria.some((item) => item.kind === "runtime")).toBe(true);

    await service.whenSettled(created.id);
    model = service.getOrchestration(created.id);
    expect(model.orchestration.status).toBe("ready");
    expect(model.orchestration.selectedMode).toBe("multi-worker");
    expect(model.plan?.routeReason).toContain("loosely coupled");
    expect(model.tasks).toHaveLength(2);
    expect(model.tasks.every((task) => task.orchestrationId === created.id)).toBe(true);
    expect(driver.executeCount).toBe(0);

    await service.startExecution(created.id);
    await service.whenSettled(created.id);

    model = service.getOrchestration(created.id);
    expect(model.orchestration.status).toBe("completed");
    expect(model.orchestration.finalOutput).toContain("Password reset implemented");
    expect(model.orchestration.completedAt).not.toBeNull();
    expect(model.verifications).toHaveLength(1);
    expect(model.verifications[0]?.scope).toBe("global");
    expect(model.artifacts).toHaveLength(1);
    expect(model.attempts).toHaveLength(2);
    expect(model.contextPackets).toHaveLength(2);
    expect(model.tasks.every((task) => task.status === "passed")).toBe(true);
    expect(model.usage.byRole.worker?.modelCalls).toBe(2);
    expect(model.usage.totalInputTokens).toBe(6_000);
    expect(model.usage.totalOutputTokens).toBe(1_800);
    expect(model.usage.pricingStatus).toBe("unknown");
    expect(model.usage.totalEstimatedUsd).toBeNull();
    expect(model.workspaceDispositions[0]?.policy).toBe("archived");

    const types = model.events.map((event) => event.type);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.created);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.intentDrafted);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.estimateRecorded);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.intentRevisionRequested);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.contractConfirmed);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.planRecorded);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.executionStarted);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.budgetReserved);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.usageCommitted);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.artifactPublished);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.artifactDependencyStale);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.integrationStarted);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.verificationRecorded);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.completed);

    const statusChanges = model.events
      .filter((event) => event.type === ORCHESTRATION_EVENT_TYPES.statusChanged)
      .map((event) => String(event.metadata.to));
    expect(statusChanges).toEqual([
      "awaiting-confirmation",
      "drafting-intent",
      "awaiting-confirmation",
      "planning",
      "ready",
      "running",
      "integrating",
      "verifying",
      "completed",
    ]);
  });

  it("survives a reload of the store", async () => {
    const harness = await createHarness();
    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const reloadedStore = new OrchestrationStore(harness.filePath);
    const reloaded = new OrchestrationControlService({
      store: reloadedStore,
      driver: new FakeDriver(),
      agents: harness.agents,
      newId: nextId,
    });
    await reloaded.initialize();

    const model = reloaded.getOrchestration(id);
    expect(model.orchestration.status).toBe("completed");
    expect(model.contractHistory).toHaveLength(1);
    expect(model.verifications).toHaveLength(1);
    expect(model.usage.totalInputTokens).toBe(6_000);
  });
});

describe("intent and contract lifecycle", () => {
  it("never plans before an explicit confirmation", async () => {
    const harness = await createHarness();
    const created = await harness.service.createOrchestration({
      agentId: harness.agentId,
      prompt: "Add password reset",
      requestedMode: "auto",
    });
    await expect(
      harness.service.confirmIntent(created.id, { confirm: true }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.driver.planCount).toBe(0);

    await harness.service.whenSettled(created.id);
    // Merely reading the orchestration must not advance it.
    harness.service.getOrchestration(created.id);
    expect(harness.driver.planCount).toBe(0);
    expect(harness.service.getOrchestration(created.id).orchestration.status).toBe(
      "awaiting-confirmation",
    );
  });

  it("refuses confirmation while material questions are unanswered", async () => {
    const harness = await createHarness();
    harness.driver.materialQuestions = [
      "Should reset links be single use?",
      "Which email provider is available?",
    ];
    const id = await createAndDraft(harness);

    await expect(
      harness.service.confirmIntent(id, { confirm: true }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      harness.service.confirmIntent(id, { confirm: true, answers: ["Yes"] }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(harness.service.getOrchestration(id).orchestration.status).toBe(
      "awaiting-confirmation",
    );

    const confirmed = await harness.service.confirmIntent(id, {
      confirm: true,
      answers: ["Yes, single use", "The queued SMTP relay"],
    });
    expect(confirmed.contract.intent.materialQuestions).toHaveLength(0);
    expect(confirmed.contract.intent.assumptions.join(" ")).toContain("single use");
    expect(confirmed.contract.intent.revision).toBe(2);
    // The reviewed revision is preserved rather than overwritten.
    const model = harness.service.getOrchestration(id);
    expect(model.intentDraftHistory[0]?.materialQuestions).toHaveLength(2);
  });

  it("keeps confirmed contract versions immutable across an amendment", async () => {
    const harness = await createHarness();
    const amendment: ContractAmendment = {
      id: "driver-amendment",
      orchestrationId: "driver-supplied",
      baseContractId: "driver-supplied",
      proposedIntent: {
        id: "driver",
        orchestrationId: "driver-supplied",
        revision: 0,
        goal: "Add password reset with an extra audit log",
        requirements: ["Reset tokens expire after 30 minutes", "Audit every reset"],
        assumptions: [],
        nonGoals: [],
        architectureDecisions: [],
        materialQuestions: [],
        manualExpectations: [],
        createdAt: "driver",
      },
      proposedCriteria: null,
      reason: "The protected check requires an audit record the contract does not mention",
      material: true,
      status: "pending",
      createdAt: "driver",
      decidedAt: null,
    };
    harness.driver.onExecute = async () => ({ kind: "needs-user", amendment });

    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    const contractV1 = harness.service.getOrchestration(id).activeContract;
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    let model = harness.service.getOrchestration(id);
    expect(model.orchestration.status).toBe("needs-user");
    expect(model.pendingAmendment?.material).toBe(true);
    expect(model.pendingAmendment?.reason).toContain("audit record");

    const amendmentId = model.pendingAmendment?.id ?? "";
    const result = await harness.service.confirmAmendment(id, amendmentId);
    expect(result.contract.version).toBe(2);
    expect(result.contract.supersedesContractId).toBe(contractV1?.id);

    await harness.service.whenSettled(id);
    model = harness.service.getOrchestration(id);
    expect(model.contractHistory).toHaveLength(2);
    expect(model.contractHistory[0]).toEqual(contractV1);
    expect(model.activeContract?.version).toBe(2);
    expect(model.activeContract?.intent.requirements).toContain("Audit every reset");
    expect(model.amendments[0]?.status).toBe("confirmed");
    expect(model.orchestration.status).toBe("ready");
    expect(harness.driver.planCount).toBe(2);
  });

  it("returns to intent confirmation when an amendment is rejected", async () => {
    const harness = await createHarness();
    harness.driver.onExecute = async () => ({
      kind: "needs-user",
      amendment: {
        id: "driver-amendment",
        orchestrationId: "driver",
        baseContractId: "driver",
        proposedIntent: {
          id: "driver",
          orchestrationId: "driver",
          revision: 0,
          goal: "Weaken the expiry requirement",
          requirements: [],
          assumptions: [],
          nonGoals: [],
          architectureDecisions: [],
          materialQuestions: [],
          manualExpectations: [],
          createdAt: "driver",
        },
        proposedCriteria: null,
        reason: "The worker wants to drop the expiry requirement",
        material: true,
        status: "pending",
        createdAt: "driver",
        decidedAt: null,
      },
    });

    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const amendmentId = harness.service.getOrchestration(id).pendingAmendment?.id ?? "";
    const updated = await harness.service.rejectAmendment(id, amendmentId);
    expect(updated.status).toBe("awaiting-confirmation");

    const model = harness.service.getOrchestration(id);
    expect(model.pendingAmendment).toBeNull();
    expect(model.amendments[0]?.status).toBe("rejected");
    // The original contract still stands; nothing was weakened silently.
    expect(model.activeContract?.version).toBe(1);
    expect(model.contractHistory).toHaveLength(1);

    await expect(
      harness.service.rejectAmendment(id, amendmentId),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("accepts explicit acceptance criteria supplied at confirmation", async () => {
    const harness = await createHarness();
    const id = await createAndDraft(harness);
    const confirmed = await harness.service.confirmIntent(id, {
      confirm: true,
      criteria: [
        {
          id: "custom-1",
          kind: "functional",
          description: "Reset flow works end to end",
          verification: "protected-test",
        },
      ],
    });
    expect(confirmed.contract.criteria).toHaveLength(1);
    expect(confirmed.contract.criteria[0]?.id).toBe("custom-1");
  });
});

describe("concurrency and Agent rules", () => {
  it("allows only one active orchestration per Agent, atomically", async () => {
    const harness = await createHarness();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        harness.service.createOrchestration({
          agentId: harness.agentId,
          prompt: "Add password reset",
          requestedMode: "auto",
        }),
      ),
    );
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    }

    const active = fulfilled[0] as PromiseFulfilledResult<{ id: string }>;
    await harness.service.whenSettled(active.value.id);
    await harness.service.cancel(active.value.id);

    // A new orchestration is allowed once the previous one is terminal.
    const next = await harness.service.createOrchestration({
      agentId: harness.agentId,
      prompt: "Add password reset again",
      requestedMode: "auto",
    });
    expect(next.status).toBe("drafting-intent");
    await harness.service.whenSettled(next.id);
  });

  it("refuses to start an orchestration for a stopped or unknown Agent", async () => {
    const harness = await createHarness();
    harness.agents.agents.set(harness.agentId, {
      id: harness.agentId,
      status: "stopped",
      workspacePath: "/tmp/workspaces/stopped",
    });
    await expect(
      harness.service.createOrchestration({
        agentId: harness.agentId,
        prompt: "Add password reset",
        requestedMode: "auto",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(
      harness.service.createOrchestration({
        agentId: "00000000-0000-4000-8000-999999999999",
        prompt: "Add password reset",
        requestedMode: "auto",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("exposes a coordinator that keeps direct runs off a busy workspace", async () => {
    const harness = await createHarness();
    const coordinator = createAgentExecutionCoordinator(harness.service);
    let release: (() => void) | null = null;
    harness.driver.onExecute = async () =>
      new Promise<ExecutionOutcome>((resolve) => {
        release = () => resolve({ kind: "completed", finalOutput: "done" });
      });

    expect(await coordinator.hasActiveOrchestration(harness.agentId)).toBe(false);
    await expect(
      coordinator.assertAgentAvailableForDirect(harness.agentId),
    ).resolves.toBeUndefined();

    const id = await createAndDraft(harness);
    // Awaiting confirmation does not touch the workspace, so direct is allowed.
    expect(await coordinator.hasActiveOrchestration(harness.agentId)).toBe(true);
    await expect(
      coordinator.assertAgentAvailableForDirect(harness.agentId),
    ).resolves.toBeUndefined();

    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);

    await expect(
      coordinator.assertAgentAvailableForDirect(harness.agentId),
    ).rejects.toMatchObject({ statusCode: 409 });

    harness.driver.onCancel = () => release?.();
    expect(await coordinator.cancelForAgent(harness.agentId)).toBe(1);
    expect(harness.service.getOrchestration(id).orchestration.status).toBe("cancelled");
    await expect(
      coordinator.assertAgentAvailableForDirect(harness.agentId),
    ).resolves.toBeUndefined();
  });
});

describe("budget enforcement", () => {
  it("stops at budget-exhausted instead of reporting success", async () => {
    const harness = await createHarness({ budget: { maxModelCalls: 1 } });
    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const model = harness.service.getOrchestration(id);
    expect(model.orchestration.status).toBe("budget-exhausted");
    expect(model.orchestration.finalOutput).toBeNull();
    expect(model.orchestration.error).toMatch(/Model-call budget/);
    expect(model.budget.exhaustedReason).toMatch(/Model-call budget/);
    expect(model.budget.modelCalls).toBe(1);

    const types = model.events.map((event) => event.type);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.budgetDenied);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.budgetExhausted);
    expect(harness.driver.cancelCount).toBeGreaterThanOrEqual(1);
  });

  it("ignores a late success reported after the budget stop", async () => {
    const harness = await createHarness({ budget: { maxModelCalls: 0 } });
    harness.driver.onExecute = async (input, sink) => {
      const decision = await sink.reserveModelCall({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: "execution-1",
        role: "planner",
        modelId: "planner-model",
        estimatedInputTokens: 10,
        estimatedOutputTokens: 10,
      });
      expect(decision.allowed).toBe(false);
      return { kind: "completed", finalOutput: "should be ignored" };
    };

    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const model = harness.service.getOrchestration(id);
    expect(model.orchestration.status).toBe("budget-exhausted");
    expect(model.orchestration.finalOutput).toBeNull();
    expect(model.events.map((event) => event.type)).toContain(
      ORCHESTRATION_EVENT_TYPES.outcomeIgnored,
    );
  });

  it("keeps cancellation available after a budget stop", async () => {
    const harness = await createHarness({ budget: { maxModelCalls: 1 } });
    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);
    expect(harness.service.getOrchestration(id).orchestration.status).toBe(
      "budget-exhausted",
    );

    const afterCancel = await harness.service.cancel(id);
    // Terminal budget state is evidence and is not overwritten.
    expect(afterCancel.status).toBe("budget-exhausted");
    expect(
      harness.service
        .getOrchestration(id)
        .events.map((event) => event.type),
    ).toContain(ORCHESTRATION_EVENT_TYPES.cancellationReconciled);
  });

  it("bounds retries and context expansions separately", async () => {
    const harness = await createHarness({
      budget: { maxWorkerAttempts: 2, maxContextExpansionsPerTask: 1 },
    });
    const decisions: string[] = [];
    harness.driver.onExecute = async (input, sink) => {
      const control = sink as ControlPlaneSink;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const decision = await control.reserveWorkerAttempt({
          taskId: "task-1",
          executionId: "execution-" + attempt,
        });
        decisions.push(decision.allowed ? "allowed" : "denied");
      }
      const first = await control.requestContextExpansion({
        taskId: "task-1",
        executionId: "execution-1",
        reason: "needs the mailer interface",
        requestedPath: "src/mailer.ts",
      });
      const second = await control.requestContextExpansion({
        taskId: "task-1",
        executionId: "execution-1",
        reason: "needs everything",
        requestedPath: "src/**",
      });
      decisions.push(first.allowed ? "expansion-allowed" : "expansion-denied");
      decisions.push(second.allowed ? "expansion-allowed" : "expansion-denied");
      return { kind: "failed", reason: "bounded loop exhausted" };
    };

    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    expect(decisions).toEqual([
      "allowed",
      "allowed",
      "denied",
      "expansion-allowed",
      "expansion-denied",
    ]);
    const model = harness.service.getOrchestration(id);
    expect(model.orchestration.status).toBe("failed");
    expect(model.budget.workerAttempts).toBe(2);
    expect(model.budget.contextExpansions).toBe(1);
    const types = model.events.map((event) => event.type);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.workerAttemptDenied);
    expect(types).toContain(ORCHESTRATION_EVENT_TYPES.contextExpansionDenied);
  });

  it("reports estimated dollars by role and total when pricing is configured", async () => {
    const harness = await createHarness({
      pricing: {
        "worker-model": {
          inputUsdPerMillionTokens: 1_000,
          cachedInputUsdPerMillionTokens: 100,
          outputUsdPerMillionTokens: 2_000,
        },
      },
    });
    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const model = harness.service.getOrchestration(id);
    expect(model.orchestration.status).toBe("completed");
    expect(model.usage.pricingStatus).toBe("configured");
    expect(model.usage.byRole.worker?.estimatedUsd).toBeCloseTo(9.7, 6);
    expect(model.usage.totalEstimatedUsd).toBeCloseTo(9.7, 6);
  });
});

describe("cancellation, restart and cleanup", () => {
  it("cancels driver work, is idempotent, and never becomes a success", async () => {
    const harness = await createHarness();
    let resolveExecute: ((outcome: ExecutionOutcome) => void) | null = null;
    harness.driver.onExecute = async () =>
      new Promise<ExecutionOutcome>((resolve) => {
        resolveExecute = resolve;
      });
    harness.driver.onCancel = () =>
      resolveExecute?.({ kind: "completed", finalOutput: "too late" });

    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    expect(harness.service.getOrchestration(id).orchestration.status).toBe("running");

    const cancelled = await harness.service.cancel(id, "Cancelled by user");
    expect(cancelled.status).toBe("cancelled");
    expect(harness.driver.cancelCount).toBe(1);

    const model = harness.service.getOrchestration(id);
    expect(model.orchestration.finalOutput).toBeNull();
    expect(model.orchestration.error).toBe("Cancelled by user");
    expect(model.tasks.every((task) => task.status === "cancelled")).toBe(true);
    // Contract, usage and safe events are retained after cancellation.
    expect(model.contractHistory).toHaveLength(1);
    expect(model.events.map((event) => event.type)).toContain(
      ORCHESTRATION_EVENT_TYPES.cancelled,
    );

    const again = await harness.service.cancel(id);
    expect(again.status).toBe("cancelled");
    expect(harness.driver.cancelCount).toBe(1);
  });

  it("rejects cancelling an already completed orchestration", async () => {
    const harness = await createHarness();
    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);
    await expect(harness.service.cancel(id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("reconciles interrupted execution on restart without claiming success", async () => {
    const harness = await createHarness();
    let resolveExecute: ((outcome: ExecutionOutcome) => void) | null = null;
    harness.driver.onExecute = async () =>
      new Promise<ExecutionOutcome>((resolve) => {
        resolveExecute = resolve;
      });

    const running = await createAndDraft(harness);
    await harness.service.confirmIntent(running, { confirm: true });
    await harness.service.whenSettled(running);
    await harness.service.startExecution(running);
    expect(harness.service.getOrchestration(running).orchestration.status).toBe("running");

    // A second Agent left waiting for user confirmation must survive restart.
    const secondAgentId = nextId();
    harness.agents.agents.set(secondAgentId, {
      id: secondAgentId,
      status: "ready",
      workspacePath: "/tmp/workspaces/" + secondAgentId,
    });
    const waiting = await harness.service.createOrchestration({
      agentId: secondAgentId,
      prompt: "Add audit logging",
      requestedMode: "auto",
    });
    await harness.service.whenSettled(waiting.id);

    const restartedStore = new OrchestrationStore(harness.filePath);
    const restarted = new OrchestrationControlService({
      store: restartedStore,
      driver: new FakeDriver(),
      agents: harness.agents,
      newId: nextId,
    });
    await restarted.initialize();

    const reconciled = restarted.getOrchestration(running);
    expect(reconciled.orchestration.status).toBe("cancelled");
    expect(reconciled.orchestration.error).toMatch(/Server restarted/);
    expect(reconciled.orchestration.finalOutput).toBeNull();
    expect(reconciled.events.map((event) => event.type)).toContain(
      ORCHESTRATION_EVENT_TYPES.restartReconciled,
    );
    expect(restarted.getOrchestration(waiting.id).orchestration.status).toBe(
      "awaiting-confirmation",
    );

    resolveExecute?.({ kind: "completed", finalOutput: "ignored" });
    await harness.service.whenSettled(running);
  });

  it("fails an orchestration when the driver rejects", async () => {
    const harness = await createHarness();
    harness.driver.onElaborate = async () => {
      throw new Error("planner endpoint unavailable");
    };
    const created = await harness.service.createOrchestration({
      agentId: harness.agentId,
      prompt: "Add password reset",
      requestedMode: "auto",
    });
    await harness.service.whenSettled(created.id);
    const model = harness.service.getOrchestration(created.id);
    expect(model.orchestration.status).toBe("failed");
    expect(model.orchestration.error).toBe("planner endpoint unavailable");
  });
});

describe("evidence safety", () => {
  it("keeps secrets, reasoning and protected material out of disk and read models", async () => {
    const harness = await createHarness();
    harness.driver.onExecute = async (input, sink) => {
      await sink.recordEvent({
        orchestrationId: input.orchestration.id,
        taskId: null,
        executionId: "execution-1",
        type: "worker.note",
        actorRole: "worker",
        modelId: "worker-model",
        summary:
          "called ark with ARK_API_KEY=ark-live-do-not-leak and Authorization: Bearer leaked-bearer-token-value",
        metadata: {
          reasoning: "first I considered ... then I decided ...",
          protectedTestSource: "expect(resetToken).toHaveLength(64)",
          apiKey: "ark-live-do-not-leak",
          safeCount: 3,
        } as never,
      });
      await sink.recordVerification({
        id: "verification-secret",
        orchestrationId: input.orchestration.id,
        taskId: null,
        scope: "protected",
        commandOrCheck: "protected acceptance suite",
        status: "passed",
        outputSummary: "12 passed",
        startedAt: "driver",
        completedAt: "driver",
      });
      return { kind: "completed", finalOutput: "done" };
    };

    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const onDisk = await readFile(harness.filePath, "utf8");
    expect(onDisk).not.toContain("ark-live-do-not-leak");
    expect(onDisk).not.toContain("leaked-bearer-token-value");
    expect(onDisk).not.toContain("first I considered");
    expect(onDisk).not.toContain("toHaveLength(64)");

    const serialized = JSON.stringify(harness.service.getOrchestration(id));
    expect(serialized).not.toContain("ark-live-do-not-leak");
    expect(serialized).not.toContain("leaked-bearer-token-value");
    expect(serialized).not.toContain("first I considered");
    expect(serialized).not.toContain("toHaveLength(64)");

    const note = harness.service
      .getOrchestration(id)
      .events.find((event) => event.type === "worker.note");
    expect(note?.metadata.safeCount).toBe(3);
    expect(note?.metadata.reasoning).toBeUndefined();
    expect(note?.metadata.protectedTestSource).toBeUndefined();
    // The protected check is still reported as evidence, without its source.
    const protectedRecord = harness.service
      .getOrchestration(id)
      .verifications.find((record) => record.scope === "protected");
    expect(protectedRecord?.status).toBe("passed");
    expect(protectedRecord?.commandOrCheck).toBe("protected acceptance suite");
  });

  it("masks absolute server paths in read models", async () => {
    const harness = await createHarness();
    const id = await createAndDraft(harness);
    await harness.service.confirmIntent(id, { confirm: true });
    await harness.service.whenSettled(id);
    await harness.service.startExecution(id);
    await harness.service.whenSettled(id);

    const disposition = harness.service.getOrchestration(id).workspaceDispositions[0];
    expect(disposition?.location).toBe("<path>/orchestration-archive/run-1");
  });

  it("paginates events without losing correlation ids", async () => {
    const harness = await createHarness();
    const id = await createAndDraft(harness);
    const all = harness.service.listEvents(id);
    expect(all.length).toBeGreaterThan(3);
    expect(all.every((event) => event.orchestrationId === id)).toBe(true);

    const tail = harness.service.listEvents(id, { limit: 2 });
    expect(tail).toHaveLength(2);
    expect(tail[1]?.id).toBe(all[all.length - 1]?.id);

    const after = harness.service.listEvents(id, { afterEventId: all[0]?.id ?? "" });
    expect(after).toHaveLength(all.length - 1);
  });

  it("returns 404 for unknown orchestrations", () => {
    return createHarness().then((harness) => {
      expect(() =>
        harness.service.getOrchestration("00000000-0000-4000-8000-000000009999"),
      ).toThrow(/not found/);
    });
  });
});
