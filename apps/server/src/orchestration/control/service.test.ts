import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClarificationQuestion,
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionOutcome,
  IntentClaim,
  IntentDraft,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  PlanInput,
  PlanResult,
} from "../contracts.js";
import type { PricingTable } from "./budget-ledger.js";
import type { AgentAccessPort, AgentSnapshot } from "./service.js";
import { OrchestrationControlService } from "./service.js";
import { IllegalTransitionError } from "./state-machine.js";
import { OrchestrationStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "orchestration-service-test-"));
  temporaryDirectories.push(root);
  return path.join(root, "orchestrations.json");
}

async function createStore(filePath?: string): Promise<OrchestrationStore> {
  const store = new OrchestrationStore(filePath ?? (await tempDbPath()));
  await store.initialize();
  return store;
}

function claim(text: string, overrides: Partial<IntentClaim> = {}): IntentClaim {
  return {
    id: "",
    text,
    provenance: "user-explicit",
    materiality: "trivial",
    rationale: null,
    supersedes: null,
    ...overrides,
  };
}

function question(overrides: Partial<ClarificationQuestion> = {}): ClarificationQuestion {
  return {
    id: randomUUID(),
    prompt: "Should reset tokens expire after 1 hour or 24 hours?",
    materiality: "material",
    consequenceIfWrong: "Tokens could remain valid too long or expire before the user can use them",
    options: [
      { id: "opt-1h", label: "1 hour", resolutionText: "Reset tokens expire after 1 hour", delegate: false },
      { id: "opt-24h", label: "24 hours", resolutionText: "Reset tokens expire after 24 hours", delegate: false },
      {
        id: "opt-delegate",
        label: "Let the AI decide",
        resolutionText: "Reset tokens expire after 1 hour (safer default)",
        delegate: true,
      },
    ],
    category: "requirements",
    relatedClaimIds: [],
    ...overrides,
  };
}

function draftSkeleton(overrides: Partial<IntentDraft> = {}): IntentDraft {
  return {
    // left empty so the service's `draft.id || randomUUID()` fallback assigns a unique id
    id: "",
    orchestrationId: "placeholder",
    revision: 0,
    goal: "Add password reset",
    requirements: [
      claim("Users can request a reset email"),
      claim("Reset tokens expire after use"),
    ],
    assumptions: [
      claim("Email delivery is already configured", {
        provenance: "repository-derived",
        rationale: "SMTP configuration found in .env.example",
      }),
    ],
    nonGoals: [claim("Do not change the login page layout")],
    architectureDecisions: [
      claim("Reuse the existing user table for token storage", {
        provenance: "planner-inferred",
        rationale: "Avoids introducing a new migration for a small feature",
      }),
    ],
    manualExpectations: [claim("The reset email should look correct in Gmail")],
    openQuestions: [],
    createdAt: "placeholder",
    ...overrides,
  };
}

function estimateSkeleton(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    inputTokenLow: 500,
    inputTokenHigh: 2000,
    outputTokenLow: 200,
    outputTokenHigh: 800,
    estimatedUsdLow: null,
    estimatedUsdHigh: null,
    pricingStatus: "unknown",
    assumptions: ["Single confirmed contract, no retries"],
    ...overrides,
  };
}

function defaultPlan(input: PlanInput): PlanResult {
  return {
    selectedMode: "direct",
    routeReason: "Single small, coupled task",
    tasks: [],
    applicationMap: {
      orchestrationId: input.orchestration.id,
      version: 1,
      repositoryHash: "fake-repo-hash",
      summary: "root workspace",
      fileCount: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

interface FakeDriverOverrides {
  elaborate?: (
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
  ) => Promise<{ draft: IntentDraft; estimate: CostEstimate }>;
  plan?: (input: PlanInput, sink: OrchestrationSink) => Promise<PlanResult>;
  execute?: (input: ExecuteInput, sink: OrchestrationSink) => Promise<ExecutionOutcome>;
  cancel?: (orchestrationId: string) => Promise<boolean>;
}

function createFakeDriver(overrides: FakeDriverOverrides = {}): OrchestrationExecutionDriver {
  return {
    elaborateIntent:
      overrides.elaborate ??
      (async () => ({ draft: draftSkeleton(), estimate: estimateSkeleton() })),
    plan: overrides.plan ?? (async (input) => defaultPlan(input)),
    execute:
      overrides.execute ?? (async () => ({ kind: "completed", finalOutput: "Password reset shipped" })),
    cancel: overrides.cancel ?? (async () => true),
  };
}

function createAgentAccess(agents: Record<string, AgentSnapshot>): AgentAccessPort {
  return { getAgent: (agentId) => agents[agentId] ?? null };
}

const readyAgent: AgentSnapshot = {
  id: "agent-1",
  status: "ready",
  workspacePath: "/workspaces/agent-1",
};

async function confirmedOrchestration(driverOverrides: FakeDriverOverrides = {}) {
  const store = await createStore();
  const driver = createFakeDriver(driverOverrides);
  const service = new OrchestrationControlService(
    store,
    createAgentAccess({ "agent-1": readyAgent }),
    driver,
  );
  const created = await service.createOrchestration({
    agentId: "agent-1",
    prompt: "Add password reset flow",
  });
  await service.waitForPendingWork(created.id);
  const contract = await service.confirmIntent({ orchestrationId: created.id });
  // confirmIntent kicks off background planning (planning -> ready); wait for
  // it so callers land on a stable "ready" orchestration, matching how the
  // real API only allows /start once planning has actually completed.
  await service.waitForPendingWork(created.id);
  return { service, store, orchestrationId: created.id, firstContract: contract };
}

describe("OrchestrationControlService: intent draft, revision, and confirmation", () => {
  it("elaborates intent in the background and reaches awaiting-confirmation", async () => {
    const store = await createStore();
    const driver = createFakeDriver();
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );

    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    expect(created.status).toBe("drafting-intent");

    await service.waitForPendingWork(created.id);

    const settled = service.getOrchestration(created.id);
    expect(settled.status).toBe("awaiting-confirmation");
    expect(settled.estimate).not.toBeNull();
    expect(settled.currentIntentDraftId).not.toBeNull();

    const readModel = service.getReadModel(created.id);
    expect(readModel.currentDraft?.revision).toBe(0);
    expect(readModel.draftHistory).toHaveLength(1);
    expect(readModel.events.some((event) => event.type === "orchestration-created")).toBe(true);
    expect(readModel.events.some((event) => event.type === "intent-elaborated")).toBe(true);
  });

  it("rejects creating an orchestration for an unknown or stopped Agent", async () => {
    const store = await createStore();
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({
        "agent-1": readyAgent,
        "agent-stopped": { id: "agent-stopped", status: "stopped", workspacePath: "/w" },
      }),
      createFakeDriver(),
    );

    await expect(
      service.createOrchestration({ agentId: "unknown-agent", prompt: "do work" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      service.createOrchestration({ agentId: "agent-stopped", prompt: "do work" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enforces one active orchestration per Agent atomically", async () => {
    const store = await createStore();
    const driver = createFakeDriver({ elaborate: () => new Promise<never>(() => undefined) });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );

    await service.createOrchestration({ agentId: "agent-1", prompt: "first task" });
    await expect(
      service.createOrchestration({ agentId: "agent-1", prompt: "second task" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects an illegal transition, such as confirming twice, with a 409", async () => {
    const { service, orchestrationId } = await confirmedOrchestration();
    await expect(service.confirmIntent({ orchestrationId })).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(service.confirmIntent({ orchestrationId })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("OrchestrationControlService: provenance and common-ground grounding", () => {
  it("retains an explicit user requirement with user-explicit provenance through to the confirmed contract", async () => {
    const { firstContract } = await confirmedOrchestration();
    const functional = firstContract.criteria.filter((criterion) => criterion.kind === "functional");
    expect(functional.length).toBeGreaterThan(0);
    for (const criterion of functional) {
      expect(criterion.provenance).toBe("user-explicit");
      expect(criterion.sourceClaimId).toBeTruthy();
    }
  });

  it("keeps a planner inference distinguishable from an explicit user requirement (never silently upgraded)", async () => {
    const { firstContract } = await confirmedOrchestration();
    const architectural = firstContract.criteria.find((criterion) => criterion.kind === "architectural");
    expect(architectural).toBeDefined();
    expect(architectural?.provenance).toBe("planner-inferred");
    expect(architectural?.provenance).not.toBe("user-explicit");

    // "why does the system believe this is part of the contract" must be answerable via the source claim
    const sourceClaim = firstContract.intent.architectureDecisions.find(
      (item) => item.id === architectural?.sourceClaimId,
    );
    expect(sourceClaim?.provenance).toBe("planner-inferred");
    expect(sourceClaim?.rationale).toMatch(/migration/i);
  });

  it("marks a repository-derived assumption distinctly from a user requirement", async () => {
    const { firstContract } = await confirmedOrchestration();
    const assumptionClaim = firstContract.intent.assumptions[0];
    expect(assumptionClaim?.provenance).toBe("repository-derived");
  });
});

describe("OrchestrationControlService: bounded, deterministic clarification policy", () => {
  it("auto-resolves a trivial ambiguity without ever surfacing it or blocking confirmation", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async () => ({
        draft: draftSkeleton({
          openQuestions: [
            question({
              materiality: "trivial",
              prompt: "Should the reset link use a query param or a path segment?",
              consequenceIfWrong: "Purely cosmetic URL shape difference",
              category: "architectureDecisions",
            }),
          ],
        }),
        estimate: estimateSkeleton(),
      }),
    });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);

    const readModel = service.getReadModel(created.id);
    expect(readModel.currentDraft?.openQuestions).toEqual([]);
    // auto-resolved into a planner-inferred claim rather than silently disappearing
    expect(
      readModel.currentDraft?.architectureDecisions.some(
        (item) => item.provenance === "planner-inferred" && item.rationale?.includes("Auto-resolved"),
      ),
    ).toBe(true);

    // does not block confirmation
    const contract = await service.confirmIntent({ orchestrationId: created.id });
    await service.waitForPendingWork(created.id);
    expect(contract.version).toBe(1);
  });

  it("blocks confirmation on a genuinely material ambiguity until it is resolved", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async () => ({
        draft: draftSkeleton({ openQuestions: [question({ materiality: "material" })] }),
        estimate: estimateSkeleton(),
      }),
    });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);

    expect(service.getReadModel(created.id).currentDraft?.openQuestions).toHaveLength(1);
    await expect(service.confirmIntent({ orchestrationId: created.id })).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("escalates a driver-mislabeled 'trivial' question when it touches a destructive/security keyword (safety net)", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async () => ({
        draft: draftSkeleton({
          openQuestions: [
            question({
              materiality: "trivial",
              prompt: "Should we automatically DELETE old reset tokens?",
              consequenceIfWrong: "Could destroy tokens/data users still need",
            }),
          ],
        }),
        estimate: estimateSkeleton(),
      }),
    });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);

    // control plane overrides the driver's own "trivial" label; still blocks
    expect(service.getReadModel(created.id).currentDraft?.openQuestions).toHaveLength(1);
    await expect(service.confirmIntent({ orchestrationId: created.id })).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

describe("OrchestrationControlService: answering and delegating clarification questions", () => {
  async function draftedWithOneQuestion() {
    const store = await createStore();
    const q = question();
    const driver = createFakeDriver({
      elaborate: async () => ({
        draft: draftSkeleton({ openQuestions: [q] }),
        estimate: estimateSkeleton(),
      }),
    });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);
    return { service, orchestrationId: created.id, question: q };
  }

  it("answering a material question with a concrete option creates a new revision (not mutated history) and unblocks confirmation", async () => {
    const { service, orchestrationId, question: q } = await draftedWithOneQuestion();

    await service.answerClarification({ orchestrationId, questionId: q.id, optionId: "opt-1h" });

    const readModel = service.getReadModel(orchestrationId);
    expect(readModel.draftHistory).toHaveLength(2);
    expect(readModel.currentDraft?.openQuestions).toEqual([]);
    const resolvedClaim = readModel.currentDraft?.requirements.find(
      (item) => item.text === "Reset tokens expire after 1 hour",
    );
    expect(resolvedClaim?.provenance).toBe("user-explicit");
    // the earlier revision still shows the question as it was asked — history is not mutated
    expect(readModel.draftHistory[0]?.openQuestions).toHaveLength(1);

    const contract = await service.confirmIntent({ orchestrationId });
    await service.waitForPendingWork(orchestrationId);
    const criterion = contract.criteria.find((item) => item.sourceClaimId === resolvedClaim?.id);
    expect(criterion?.provenance).toBe("user-explicit");
  });

  it("delegating a decision resolves it without the user specifying the implementation choice, tagged user-delegated", async () => {
    const { service, orchestrationId, question: q } = await draftedWithOneQuestion();

    await service.answerClarification({
      orchestrationId,
      questionId: q.id,
      optionId: "opt-delegate",
    });

    const readModel = service.getReadModel(orchestrationId);
    const resolvedClaim = readModel.currentDraft?.requirements.find(
      (item) => item.text === "Reset tokens expire after 1 hour (safer default)",
    );
    expect(resolvedClaim?.provenance).toBe("user-delegated");
    expect(resolvedClaim?.rationale).toMatch(/delegated/i);

    const contract = await service.confirmIntent({ orchestrationId });
    await service.waitForPendingWork(orchestrationId);
    const criterion = contract.criteria.find((item) => item.sourceClaimId === resolvedClaim?.id);
    expect(criterion?.provenance).toBe("user-delegated");
  });

  it("accepts free-text correction when no listed option fits, tagged user-explicit", async () => {
    const { service, orchestrationId, question: q } = await draftedWithOneQuestion();
    await service.answerClarification({ orchestrationId, questionId: q.id, freeText: "Use 2 hours instead" });
    const readModel = service.getReadModel(orchestrationId);
    const resolvedClaim = readModel.currentDraft?.requirements.find(
      (item) => item.text === "Use 2 hours instead",
    );
    expect(resolvedClaim?.provenance).toBe("user-explicit");
  });

  it("rejects answering with neither an option nor free text, and rejects an unknown question id", async () => {
    const { service, orchestrationId, question: q } = await draftedWithOneQuestion();
    await expect(
      service.answerClarification({ orchestrationId, questionId: q.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.answerClarification({ orchestrationId, questionId: "not-a-real-question", freeText: "x" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

/**
 * Per the frozen state table, `proposeAmendment`'s target status
 * ("needs-user") is only reachable from "planning" (before the automatic
 * post-confirm plan() completes) or from an active execution state
 * ("running"/"integrating"/"verifying") — never from "ready". These tests
 * exercise the manual/API-initiated amendment path (as opposed to a
 * driver-originated one from execute(), already covered under "plan/execute
 * lifecycle"), so they hold the orchestration at "planning" deterministically
 * by giving the driver a plan() call that never resolves.
 */
async function confirmedOrchestrationDuringPlanning() {
  const store = await createStore();
  const driver = createFakeDriver({ plan: () => new Promise<never>(() => undefined) });
  const service = new OrchestrationControlService(
    store,
    createAgentAccess({ "agent-1": readyAgent }),
    driver,
  );
  const created = await service.createOrchestration({
    agentId: "agent-1",
    prompt: "Add password reset flow",
  });
  await service.waitForPendingWork(created.id);
  const contract = await service.confirmIntent({ orchestrationId: created.id });
  // deliberately not awaiting waitForPendingWork here: the fake plan() never
  // resolves, so status stays "planning" for the rest of the test.
  return { service, orchestrationId: created.id, firstContract: contract };
}

describe("OrchestrationControlService: immutable contract versions and amendments", () => {
  it("keeps prior contract versions intact and immutable after a confirmed material amendment", async () => {
    const { service, orchestrationId, firstContract } = await confirmedOrchestrationDuringPlanning();

    const amendment = await service.proposeAmendment({
      orchestrationId,
      reason: "Discovered the reset link must be single-use",
      requirements: [
        "Users can request a reset email",
        "Reset tokens expire after use",
        "Reset tokens can only be used once",
      ],
    });
    expect(amendment.status).toBe("pending");
    expect(service.getOrchestration(orchestrationId).status).toBe("needs-user");

    const secondContract = await service.confirmAmendment(orchestrationId, amendment.id);
    // confirmAmendment also kicks off background planning; this test's fake
    // driver's plan() never resolves (see confirmedOrchestrationDuringPlanning),
    // so that background task is deliberately never awaited — it causes no
    // writes and no race, since it never gets past the driver.plan() call.
    expect(secondContract.version).toBe(2);
    expect(secondContract.supersedesContractId).toBe(firstContract.id);
    expect(secondContract.intent.requirements.map((item) => item.text)).toContain(
      "Reset tokens can only be used once",
    );

    const readModel = service.getReadModel(orchestrationId);
    expect(readModel.contractHistory).toHaveLength(2);
    const original = readModel.contractHistory.find((item) => item.id === firstContract.id);
    expect(original?.criteria).toEqual(firstContract.criteria);
    expect(service.getOrchestration(orchestrationId).activeContractId).toBe(secondContract.id);
    expect(service.getOrchestration(orchestrationId).status).toBe("planning");
  });

  it("leaves the active contract unchanged when a material amendment is rejected", async () => {
    const { service, orchestrationId, firstContract } = await confirmedOrchestrationDuringPlanning();

    const amendment = await service.proposeAmendment({
      orchestrationId,
      reason: "Suggested change the user did not want",
    });
    const rejected = await service.rejectAmendment(orchestrationId, amendment.id);
    expect(rejected.status).toBe("rejected");

    const orchestration = service.getOrchestration(orchestrationId);
    expect(orchestration.status).toBe("planning");
    expect(orchestration.activeContractId).toBe(firstContract.id);
    expect(service.getReadModel(orchestrationId).contractHistory).toHaveLength(1);
  });

  it("rejects proposing a second amendment while one is already pending", async () => {
    const { service, orchestrationId } = await confirmedOrchestrationDuringPlanning();
    await service.proposeAmendment({ orchestrationId, reason: "first change" });
    await expect(
      service.proposeAmendment({ orchestrationId, reason: "second change" }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("rejects amending before any contract has been confirmed", async () => {
    const store = await createStore();
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver(),
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);
    await expect(
      service.proposeAmendment({ orchestrationId: created.id, reason: "too early" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("OrchestrationControlService: estimate and hard budget", () => {
  it("shows the estimate before confirmation and denies confirmation once it exceeds the hard budget", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async () => ({ draft: draftSkeleton(), estimate: estimateSkeleton({ inputTokenLow: 5000 }) }),
    });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
      budget: { maxInputTokens: 100 },
    });
    await service.waitForPendingWork(created.id);

    const settled = service.getOrchestration(created.id);
    expect(settled.status).toBe("awaiting-confirmation");
    expect(settled.estimate?.inputTokenLow).toBe(5000);

    await expect(service.confirmIntent({ orchestrationId: created.id })).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(service.getOrchestration(created.id).status).toBe("awaiting-confirmation");
  });

  it("confirms normally when the estimate fits comfortably inside the hard budget", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async () => ({
        draft: draftSkeleton(),
        estimate: estimateSkeleton({ inputTokenLow: 100, outputTokenLow: 50 }),
      }),
    });
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
      budget: { maxInputTokens: 100_000, maxOutputTokens: 100_000 },
    });
    await service.waitForPendingWork(created.id);
    const contract = await service.confirmIntent({ orchestrationId: created.id });
    await service.waitForPendingWork(created.id);
    expect(contract.version).toBe(1);
  });

  it("routes actual model spend through the sink and enforces the hard budget on the reservation itself", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async (input, sink) => {
        const decision = await sink.reserveModelCall({
          orchestrationId: input.orchestrationId,
          taskId: null,
          executionId: "exec-1",
          role: "planner",
          modelId: "ep-strong",
          estimatedInputTokens: 300,
          estimatedOutputTokens: 100,
        });
        if (!decision.allowed) {
          throw new Error(`Budget denied: ${decision.reason}`);
        }
        await sink.commitModelUsage(decision.reservationId, {
          inputTokens: 280,
          cachedInputTokens: 0,
          outputTokens: 90,
        });
        return { draft: draftSkeleton(), estimate: estimateSkeleton() };
      },
    });
    const otherAgent: AgentSnapshot = {
      id: "agent-2",
      status: "ready",
      workspacePath: "/workspaces/agent-2",
    };
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent, "agent-2": otherAgent }),
      driver,
    );

    const withinBudget = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
      budget: { maxInputTokens: 10_000 },
    });
    await service.waitForPendingWork(withinBudget.id);
    const afterSuccess = service.getOrchestration(withinBudget.id);
    expect(afterSuccess.status).toBe("awaiting-confirmation");
    expect(afterSuccess.usage.byRole.planner?.inputTokens).toBe(280);
    expect(afterSuccess.usage.byRole.planner?.modelCalls).toBe(1);

    const overBudget = await service.createOrchestration({
      agentId: "agent-2",
      prompt: "Another task",
      budget: { maxInputTokens: 10 },
    });
    await service.waitForPendingWork(overBudget.id);
    const afterDenial = service.getOrchestration(overBudget.id);
    expect(afterDenial.status).toBe("drafting-intent");
    expect(afterDenial.error).toMatch(/budget denied/i);
    expect(
      service.getReadModel(overBudget.id).events.some((event) => event.type === "budget-denied"),
    ).toBe(true);
  });

  it("prices spend once a pricing table is supplied and keeps totals unknown otherwise", async () => {
    const store = await createStore();
    const driver = createFakeDriver({
      elaborate: async (input, sink) => {
        const decision = await sink.reserveModelCall({
          orchestrationId: input.orchestrationId,
          taskId: null,
          executionId: "exec-1",
          role: "planner",
          modelId: "ep-strong",
          estimatedInputTokens: 100,
          estimatedOutputTokens: 100,
        });
        if (decision.allowed) {
          await sink.commitModelUsage(decision.reservationId, {
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 100,
          });
        }
        return { draft: draftSkeleton(), estimate: estimateSkeleton() };
      },
    });
    const pricing: PricingTable = {
      planner: { inputPerToken: 0.001, cachedInputPerToken: 0, outputPerToken: 0.002 },
    };
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
      pricing,
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);
    const usage = service.getOrchestration(created.id).usage;
    expect(usage.pricingStatus).toBe("configured");
    expect(usage.totalEstimatedUsd).toBeCloseTo(0.1 + 0.2);
  });
});

describe("OrchestrationControlService: plan/execute lifecycle", () => {
  it("cannot start before a confirmed contract exists", async () => {
    const store = await createStore();
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver(),
    );
    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service.waitForPendingWork(created.id);
    await expect(service.startOrchestration(created.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not start merely because confirm was called — rejects /start while planning is still in flight, before the plan is reviewable", async () => {
    const store = await createStore();
    const driver = createFakeDriver({ plan: () => new Promise<never>(() => undefined) });
    const service = new OrchestrationControlService(store, createAgentAccess({ "agent-1": readyAgent }), driver);
    const created = await service.createOrchestration({ agentId: "agent-1", prompt: "Add password reset flow" });
    await service.waitForPendingWork(created.id);
    await service.confirmIntent({ orchestrationId: created.id });

    // plan() is hung: status is "planning", not yet "ready" — nothing to review yet
    expect(service.getOrchestration(created.id).status).toBe("planning");
    await expect(service.startOrchestration(created.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("runs plan then execute on start and reaches completed on success, recording route/task/map evidence", async () => {
    const { service, orchestrationId } = await confirmedOrchestration({
      plan: async (input) => ({
        selectedMode: "one-worker",
        routeReason: "Two related requirements, low coupling",
        tasks: [],
        applicationMap: {
          orchestrationId: input.orchestration.id,
          version: 1,
          repositoryHash: "hash-1",
          summary: "root",
          fileCount: 3,
          createdAt: new Date().toISOString(),
        },
      }),
      execute: async () => ({ kind: "completed", finalOutput: "Shipped password reset" }),
    });

    expect(service.getOrchestration(orchestrationId).status).toBe("ready");
    const started = await service.startOrchestration(orchestrationId);
    expect(started.status).toBe("ready");
    await service.waitForPendingWork(orchestrationId);

    const final = service.getOrchestration(orchestrationId);
    expect(final.status).toBe("completed");
    expect(final.finalOutput).toBe("Shipped password reset");
    expect(final.selectedMode).toBe("one-worker");

    const readModel = service.getReadModel(orchestrationId);
    expect(readModel.applicationMap?.fileCount).toBe(3);
    expect(readModel.events.some((event) => event.type === "planned")).toBe(true);
    expect(readModel.events.some((event) => event.type === "execution-completed")).toBe(true);
  });

  it("execute() reporting a material conflict pauses through needs-user with a persisted amendment instead of silently weakening the contract", async () => {
    const { service, orchestrationId, firstContract } = await confirmedOrchestration({
      execute: async (input) => {
        const amendment: ContractAmendment = {
          id: "",
          orchestrationId: input.orchestration.id,
          baseContractId: input.contract.id,
          proposedIntent: {
            ...input.contract.intent,
            id: randomUUID(),
            revision: input.contract.intent.revision + 1,
            requirements: [
              ...input.contract.intent.requirements,
              claim("Reset tokens must be revocable via a new public API endpoint", {
                provenance: "planner-inferred",
                rationale: "Discovered while implementing single-use tokens",
              }),
            ],
          },
          proposedCriteria: null,
          reason: "A public API must change to support token revocation; this was not in the confirmed contract",
          material: true,
          status: "pending",
          createdAt: new Date().toISOString(),
          decidedAt: null,
        };
        return { kind: "needs-user", amendment };
      },
    });

    await service.startOrchestration(orchestrationId);
    await service.waitForPendingWork(orchestrationId);

    const paused = service.getOrchestration(orchestrationId);
    expect(paused.status).toBe("needs-user");
    // the originally confirmed contract must be untouched
    expect(service.getOrchestration(orchestrationId).activeContractId).toBe(firstContract.id);

    const readModel = service.getReadModel(orchestrationId);
    expect(readModel.pendingAmendment?.reason).toMatch(/public api/i);
    expect(readModel.pendingAmendment?.status).toBe("pending");

    const secondContract = await service.confirmAmendment(
      orchestrationId,
      readModel.pendingAmendment!.id,
    );
    await service.waitForPendingWork(orchestrationId);
    expect(secondContract.version).toBe(2);
    expect(secondContract.supersedesContractId).toBe(firstContract.id);
    // v1 remains exactly as confirmed
    const historyAfter = service.getReadModel(orchestrationId).contractHistory;
    const original = historyAfter.find((item) => item.id === firstContract.id);
    expect(original?.criteria).toEqual(firstContract.criteria);
  });

  it("records a budget-exhausted outcome from execute() as a terminal state", async () => {
    const { service, orchestrationId } = await confirmedOrchestration({
      execute: async () => ({ kind: "budget-exhausted", reason: "Worker token budget exhausted" }),
    });
    await service.startOrchestration(orchestrationId);
    await service.waitForPendingWork(orchestrationId);
    const final = service.getOrchestration(orchestrationId);
    expect(final.status).toBe("budget-exhausted");
    expect(final.error).toMatch(/budget exhausted/i);
  });

  it("cancels an in-flight execution immediately even if the driver's execute() never resolves", async () => {
    let cancelCalled = false;
    const { service, orchestrationId } = await confirmedOrchestration({
      execute: () => new Promise<never>(() => undefined),
      cancel: async () => {
        cancelCalled = true;
        return true;
      },
    });
    await service.startOrchestration(orchestrationId);
    const cancelled = await service.cancelOrchestration(orchestrationId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelCalled).toBe(true);
  });

  it("cancelling twice is idempotent and never resurrects a terminal orchestration", async () => {
    const { service, orchestrationId } = await confirmedOrchestration();
    await service.startOrchestration(orchestrationId);
    await service.waitForPendingWork(orchestrationId);
    expect(service.getOrchestration(orchestrationId).status).toBe("completed");
    const result = await service.cancelOrchestration(orchestrationId);
    expect(result.status).toBe("completed");
  });
});

describe("OrchestrationControlService: restart reconciliation", () => {
  it("marks an interrupted non-terminal orchestration cancelled on restart, without claiming success", async () => {
    const filePath = await tempDbPath();
    const store1 = await createStore(filePath);
    const service1 = new OrchestrationControlService(
      store1,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver({ elaborate: () => new Promise<never>(() => undefined) }),
    );
    const created = await service1.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    expect(created.status).toBe("drafting-intent");

    const store2 = new OrchestrationStore(filePath);
    const service2 = new OrchestrationControlService(
      store2,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver(),
    );
    await service2.initialize();

    const reconciled = service2.getOrchestration(created.id);
    expect(reconciled.status).toBe("cancelled");
    expect(reconciled.error).toMatch(/restart/i);
  });

  it("leaves a genuinely completed orchestration untouched across a restart", async () => {
    const filePath = await tempDbPath();
    const store1 = await createStore(filePath);
    const service1 = new OrchestrationControlService(
      store1,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver(),
    );
    const created = await service1.createOrchestration({
      agentId: "agent-1",
      prompt: "Add password reset flow",
    });
    await service1.waitForPendingWork(created.id);
    await service1.confirmIntent({ orchestrationId: created.id });
    await service1.waitForPendingWork(created.id); // background planning: planning -> ready
    await service1.startOrchestration(created.id);
    await service1.waitForPendingWork(created.id); // background execution: running -> ... -> completed
    expect(service1.getOrchestration(created.id).status).toBe("completed");

    const store2 = new OrchestrationStore(filePath);
    const service2 = new OrchestrationControlService(
      store2,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver(),
    );
    await service2.initialize();
    expect(service2.getOrchestration(created.id).status).toBe("completed");
    expect(service2.getReadModel(created.id).events.length).toBeGreaterThan(0);
  });
});

describe("OrchestrationControlService: redaction", () => {
  it("never persists or returns a raw secret found in the user prompt", async () => {
    const store = await createStore();
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      createFakeDriver(),
    );

    const created = await service.createOrchestration({
      agentId: "agent-1",
      prompt: "Please use ARK_API_KEY=abcd1234efgh5678 to configure the client",
    });
    await service.waitForPendingWork(created.id);

    const stored = store.snapshot().orchestrations.find((item) => item.id === created.id);
    expect(stored?.prompt).not.toContain("abcd1234efgh5678");

    const readModel = service.getReadModel(created.id);
    expect(JSON.stringify(readModel)).not.toContain("abcd1234efgh5678");
  });
});
