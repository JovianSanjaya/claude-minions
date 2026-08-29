import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CostEstimate,
  ElaborateIntentInput,
  IntentDraft,
  OrchestrationExecutionDriver,
  OrchestrationSink,
} from "../contracts.js";
import type { AgentAccessPort, AgentSnapshot } from "./service.js";
import { OrchestrationControlService } from "./service.js";
import { IllegalTransitionError } from "./state-machine.js";
import { OrchestrationStore } from "./store.js";
import type { PricingTable } from "./budget-ledger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<OrchestrationStore> {
  const root = await mkdtemp(path.join(tmpdir(), "orchestration-service-test-"));
  temporaryDirectories.push(root);
  const store = new OrchestrationStore(path.join(root, "orchestrations.json"));
  await store.initialize();
  return store;
}

function draftSkeleton(overrides: Partial<IntentDraft> = {}): IntentDraft {
  return {
    // left empty so the service's `draft.id || randomUUID()` fallback assigns
    // a fresh, unique id per elaboration call rather than colliding.
    id: "",
    orchestrationId: "placeholder",
    revision: 0,
    goal: "Add password reset",
    requirements: ["Users can request a reset email", "Reset tokens expire after use"],
    assumptions: ["Email delivery is already configured"],
    nonGoals: ["Do not change the login page layout"],
    architectureDecisions: ["Reuse the existing user table for token storage"],
    materialQuestions: [],
    manualExpectations: ["The reset email should look correct in Gmail"],
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

/** A deterministic fake driver: only elaborateIntent is exercised by this restricted control plane. */
function createFakeDriver(
  elaborate: (
    input: ElaborateIntentInput,
    sink: OrchestrationSink,
  ) => Promise<{ draft: IntentDraft; estimate: CostEstimate }>,
): OrchestrationExecutionDriver {
  return {
    elaborateIntent: (input, sink) => elaborate(input, sink),
    plan: () => {
      throw new Error("plan() is out of scope for this restricted control-plane build");
    },
    execute: () => {
      throw new Error("execute() is out of scope for this restricted control-plane build");
    },
    cancel: async () => false,
  };
}

function createAgentAccess(agents: Record<string, AgentSnapshot>): AgentAccessPort {
  return {
    getAgent: (agentId) => agents[agentId] ?? null,
  };
}

const readyAgent: AgentSnapshot = {
  id: "agent-1",
  status: "ready",
  workspacePath: "/workspaces/agent-1",
};

describe("OrchestrationControlService: intent draft, revision, and confirmation", () => {
  it("elaborates intent in the background and reaches awaiting-confirmation", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
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
  });

  it("rejects creating an orchestration for an unknown or stopped Agent", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({
        "agent-1": readyAgent,
        "agent-stopped": { id: "agent-stopped", status: "stopped", workspacePath: "/w" },
      }),
      driver,
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
    const driver = createFakeDriver(
      () => new Promise<never>(() => undefined), // never resolves: keeps the first orchestration "active"
    );
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

  it("blocks confirmation while material questions are unresolved, then allows it once a revision clears them", async () => {
    const store = await createStore();
    let call = 0;
    const driver = createFakeDriver(async () => {
      call += 1;
      if (call === 1) {
        return {
          draft: draftSkeleton({ materialQuestions: ["Should tokens expire in 1h or 24h?"] }),
          estimate: estimateSkeleton(),
        };
      }
      return {
        draft: draftSkeleton({ assumptions: ["Tokens expire after 1 hour, per user revision"] }),
        estimate: estimateSkeleton(),
      };
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

    await expect(service.confirmIntent({ orchestrationId: created.id })).rejects.toMatchObject({
      statusCode: 422,
    });

    const revising = await service.reviseIntent(created.id, "Use a 1 hour expiry");
    expect(revising.status).toBe("drafting-intent");

    await service.waitForPendingWork(created.id);

    const settled = service.getOrchestration(created.id);
    expect(settled.status).toBe("awaiting-confirmation");

    const readModel = service.getReadModel(created.id);
    expect(readModel.draftHistory).toHaveLength(2);
    expect(readModel.currentDraft?.revision).toBe(1);
    expect(readModel.currentDraft?.materialQuestions).toEqual([]);

    const contract = await service.confirmIntent({ orchestrationId: created.id });
    expect(contract.version).toBe(1);
    expect(service.getOrchestration(created.id).status).toBe("planning");
  });

  it("derives typed acceptance criteria across functional, architectural, scope, manual, and runtime categories", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
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

    const kinds = new Set(contract.criteria.map((criterion) => criterion.kind));
    expect(kinds).toEqual(new Set(["functional", "architectural", "scope", "manual", "runtime"]));
    // one criterion per requirement/decision/nonGoal/manualExpectation, plus the baseline runtime one
    expect(contract.criteria).toHaveLength(2 + 1 + 1 + 1 + 1);
    for (const criterion of contract.criteria) {
      expect(criterion.id).toBeTruthy();
      expect(criterion.description.length).toBeGreaterThan(0);
    }
  });

  it("rejects an illegal transition, such as confirming twice, with a 409", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
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
    await service.confirmIntent({ orchestrationId: created.id });

    await expect(service.confirmIntent({ orchestrationId: created.id })).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(service.confirmIntent({ orchestrationId: created.id })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("OrchestrationControlService: immutable contract versions and amendments", () => {
  async function confirmedOrchestration() {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
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
    return { service, orchestrationId: created.id, firstContract: contract };
  }

  it("keeps prior contract versions intact and immutable after a confirmed material amendment", async () => {
    const { service, orchestrationId, firstContract } = await confirmedOrchestration();

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
    expect(secondContract.version).toBe(2);
    expect(secondContract.supersedesContractId).toBe(firstContract.id);
    expect(secondContract.intent.requirements).toContain("Reset tokens can only be used once");

    const readModel = service.getReadModel(orchestrationId);
    expect(readModel.contractHistory).toHaveLength(2);
    // the original, already-confirmed contract is untouched
    const original = readModel.contractHistory.find((item) => item.id === firstContract.id);
    expect(original?.criteria).toEqual(firstContract.criteria);
    expect(service.getOrchestration(orchestrationId).activeContractId).toBe(secondContract.id);
    expect(service.getOrchestration(orchestrationId).status).toBe("planning");
  });

  it("leaves the active contract unchanged when a material amendment is rejected", async () => {
    const { service, orchestrationId, firstContract } = await confirmedOrchestration();

    const amendment = await service.proposeAmendment({
      orchestrationId,
      reason: "Suggested change the user did not want",
    });
    const rejected = await service.rejectAmendment(orchestrationId, amendment.id);
    expect(rejected.status).toBe("rejected");

    const orchestration = service.getOrchestration(orchestrationId);
    expect(orchestration.status).toBe("planning");
    expect(orchestration.activeContractId).toBe(firstContract.id);

    const readModel = service.getReadModel(orchestrationId);
    expect(readModel.contractHistory).toHaveLength(1);
  });

  it("rejects proposing a second amendment while one is already pending", async () => {
    const { service, orchestrationId } = await confirmedOrchestration();
    await service.proposeAmendment({ orchestrationId, reason: "first change" });
    await expect(
      service.proposeAmendment({ orchestrationId, reason: "second change" }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("rejects amending before any contract has been confirmed", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
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

    await expect(
      service.proposeAmendment({ orchestrationId: created.id, reason: "too early" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("OrchestrationControlService: estimate and hard budget", () => {
  it("shows the estimate before confirmation and denies confirmation once it exceeds the hard budget", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton({ inputTokenLow: 5000 }),
    }));
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
    // the denial does not silently weaken the budget or force a state change
    expect(service.getOrchestration(created.id).status).toBe("awaiting-confirmation");
  });

  it("confirms normally when the estimate fits comfortably inside the hard budget", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton({ inputTokenLow: 100, outputTokenLow: 50 }),
    }));
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
    expect(contract.version).toBe(1);
  });

  it("routes actual model spend through the sink and enforces the hard budget on the reservation itself", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async (input, sink) => {
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

    // a different Agent, since only one active orchestration is allowed per Agent
    const overBudget = await service.createOrchestration({
      agentId: "agent-2",
      prompt: "Another task",
      budget: { maxInputTokens: 10 },
    });
    await service.waitForPendingWork(overBudget.id);
    const afterDenial = service.getOrchestration(overBudget.id);
    // the elaboration call failed because the reservation was denied; the
    // orchestration stays in drafting-intent (no illegal state transition)
    // and records why, instead of silently proceeding.
    expect(afterDenial.status).toBe("drafting-intent");
    expect(afterDenial.error).toMatch(/budget denied/i);
  });

  it("prices spend once a pricing table is supplied and keeps totals unknown otherwise", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async (input, sink) => {
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

describe("OrchestrationControlService: redaction", () => {
  it("never persists or returns a raw secret found in the user prompt", async () => {
    const store = await createStore();
    const driver = createFakeDriver(async () => ({
      draft: draftSkeleton(),
      estimate: estimateSkeleton(),
    }));
    const service = new OrchestrationControlService(
      store,
      createAgentAccess({ "agent-1": readyAgent }),
      driver,
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
