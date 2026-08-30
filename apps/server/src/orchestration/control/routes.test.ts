import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type {
  ContractAmendment,
  CostEstimate,
  ElaborateIntentInput,
  ExecuteInput,
  ExecutionOutcome,
  IntentDraft,
  OrchestrationExecutionDriver,
  PlanInput,
  PlanResult,
} from "../contracts.js";
import { registerOrchestrationRoutes } from "./routes.js";
import type { AgentAccessPort, AgentAccessSummary } from "./service.js";
import { OrchestrationControlService } from "./service.js";
import { OrchestrationStore } from "./store.js";

/* ------------------------------------------------------------------ fakes */

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

/** Deterministic fake driver, scoped to the HTTP boundary tests. */
class FakeDriver implements OrchestrationExecutionDriver {
  materialQuestions: string[] = [];
  outcome: ExecutionOutcome = { kind: "completed", finalOutput: "done" };

  async elaborateIntent(
    input: ElaborateIntentInput,
  ): Promise<{ draft: IntentDraft; estimate: CostEstimate }> {
    return {
      draft: {
        id: "driver",
        orchestrationId: input.orchestrationId,
        revision: 1,
        goal: "Add password reset",
        requirements: ["Tokens expire after 30 minutes"],
        assumptions: [],
        nonGoals: [],
        architectureDecisions: [],
        materialQuestions: [...this.materialQuestions],
        manualExpectations: [],
        createdAt: "driver",
      },
      estimate: {
        inputTokenLow: 100,
        inputTokenHigh: 200,
        outputTokenLow: 10,
        outputTokenHigh: 20,
        estimatedUsdLow: null,
        estimatedUsdHigh: null,
        pricingStatus: "unknown",
        assumptions: [],
      },
    };
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    return {
      selectedMode: "one-worker",
      routeReason: "Single focused module",
      tasks: [
        {
          id: "task-1",
          orchestrationId: input.orchestration.id,
          title: "Implement reset",
          objective: "Add the reset endpoint",
          status: "ready",
          dependsOn: [],
          allowedPaths: ["src/**"],
          acceptanceCriterionIds: ["c1"],
          requiredArtifactIds: [],
          observedArtifactVersions: {},
          applicationMapVersion: 1,
          attemptCount: 0,
        },
      ],
      applicationMap: {
        orchestrationId: input.orchestration.id,
        version: 1,
        repositoryHash: "hash",
        summary: "small repository",
        fileCount: 5,
        createdAt: "driver",
      },
    };
  }

  async execute(input: ExecuteInput): Promise<ExecutionOutcome> {
    void input;
    return this.outcome;
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

const agents: AgentAccessPort = {
  async getAgent(agentId: string): Promise<AgentAccessSummary | null> {
    if (agentId !== AGENT_ID) {
      return null;
    }
    return { id: AGENT_ID, status: "ready", workspacePath: "/tmp/workspaces/agent" };
  },
};

/** The baseline app requires an AgentService only for its own routes. */
const agentServiceStub = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>;
  service: OrchestrationControlService;
  driver: FakeDriver;
}

let directory: string;
let counter = 0;

async function createHarness(authToken?: string): Promise<Harness> {
  counter += 1;
  const store = new OrchestrationStore(
    path.join(directory, "orchestrations-" + counter + ".json"),
  );
  const driver = new FakeDriver();
  const service = new OrchestrationControlService({ store, driver, agents });
  await service.initialize();
  const app = await createApp(
    loadConfig({
      NODE_ENV: "test",
      ...(authToken === undefined ? {} : { APP_AUTH_TOKEN: authToken }),
    }),
    agentServiceStub,
  );
  registerOrchestrationRoutes(app, service);
  return { app, service, driver };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "orchestration-routes-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function createOrchestration(harness: Harness): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/agents/" + AGENT_ID + "/orchestrations",
    payload: { prompt: "Add password reset", requestedMode: "orchestrated" },
  });
  expect(response.statusCode).toBe(202);
  const body = response.json() as { orchestration: { id: string } };
  await harness.service.whenSettled(body.orchestration.id);
  return body.orchestration.id;
}

/* ----------------------------------------------------------------- tests */

describe("orchestration routes", () => {
  it("accepts asynchronous creation with 202 and lists orchestrations", async () => {
    const harness = await createHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "Add password reset", requestedMode: "auto" },
    });
    expect(created.statusCode).toBe(202);
    const body = created.json() as { orchestration: { id: string; status: string } };
    expect(body.orchestration.status).toBe("drafting-intent");
    await harness.service.whenSettled(body.orchestration.id);

    const list = await harness.app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { orchestrations: unknown[] }).orchestrations).toHaveLength(1);
    await harness.app.close();
  });

  it("returns 400 for malformed bodies and parameters", async () => {
    const harness = await createHarness();

    const emptyPrompt = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "   " },
    });
    expect(emptyPrompt.statusCode).toBe(400);

    const badMode = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "hello", requestedMode: "turbo" },
    });
    expect(badMode.statusCode).toBe(400);

    const negativeBudget = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "hello", budget: { maxModelCalls: -5 } },
    });
    expect(negativeBudget.statusCode).toBe(400);

    const unreasonableBudget = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "hello", budget: { maxInputTokens: 999_999_999_999 } },
    });
    expect(unreasonableBudget.statusCode).toBe(400);

    const unknownBudgetField = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "hello", budget: { maxModelCallsTypo: 5 } },
    });
    expect(unknownBudgetField.statusCode).toBe(400);

    const badId = await harness.app.inject({
      method: "GET",
      url: "/api/orchestrations/not-a-uuid",
    });
    expect(badId.statusCode).toBe(400);
    await harness.app.close();
  });

  it("returns 404 for unknown Agents and orchestrations", async () => {
    const harness = await createHarness();
    const unknownAgent = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + UNKNOWN_ID + "/orchestrations",
      payload: { prompt: "Add password reset" },
    });
    expect(unknownAgent.statusCode).toBe(404);

    const unknownOrchestration = await harness.app.inject({
      method: "GET",
      url: "/api/orchestrations/" + UNKNOWN_ID,
    });
    expect(unknownOrchestration.statusCode).toBe(404);
    await harness.app.close();
  });

  it("returns 409 for concurrency conflicts and illegal transitions", async () => {
    const harness = await createHarness();
    const id = await createOrchestration(harness);

    const second = await harness.app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      payload: { prompt: "Another one" },
    });
    expect(second.statusCode).toBe(409);

    const earlyStart = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/start",
    });
    expect(earlyStart.statusCode).toBe(409);
    await harness.app.close();
  });

  it("returns 422 for a semantically invalid confirmation", async () => {
    const harness = await createHarness();
    harness.driver.materialQuestions = ["Should reset links be single use?"];
    const id = await createOrchestration(harness);

    const unanswered = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/confirm",
      payload: { confirm: true },
    });
    expect(unanswered.statusCode).toBe(422);

    // A malformed shape is a 400; only semantics reach 422.
    const notConfirmed = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/confirm",
      payload: { confirm: false },
    });
    expect(notConfirmed.statusCode).toBe(400);

    const confirmed = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/confirm",
      payload: { confirm: true, answers: ["Yes, single use"] },
    });
    expect(confirmed.statusCode).toBe(202);
    await harness.app.close();
  });

  it("drives the full journey over HTTP and exposes evidence collections", async () => {
    const harness = await createHarness();
    const id = await createOrchestration(harness);

    const revised = await harness.app.inject({
      method: "PATCH",
      url: "/api/orchestrations/" + id + "/intent",
      payload: { feedback: "Also add rate limiting" },
    });
    expect(revised.statusCode).toBe(202);
    await harness.service.whenSettled(id);

    const emptyFeedback = await harness.app.inject({
      method: "PATCH",
      url: "/api/orchestrations/" + id + "/intent",
      payload: { feedback: "  " },
    });
    expect(emptyFeedback.statusCode).toBe(400);

    const confirmed = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/confirm",
      payload: { confirm: true },
    });
    expect(confirmed.statusCode).toBe(202);
    expect(
      (confirmed.json() as { contract: { version: number } }).contract.version,
    ).toBe(1);
    await harness.service.whenSettled(id);

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/start",
    });
    expect(started.statusCode).toBe(202);
    await harness.service.whenSettled(id);

    const read = await harness.app.inject({ method: "GET", url: "/api/orchestrations/" + id });
    expect(read.statusCode).toBe(200);
    const model = read.json() as {
      orchestration: { status: string };
      plan: { routeReason: string } | null;
      usage: { pricingStatus: string };
    };
    expect(model.orchestration.status).toBe("completed");
    expect(model.plan?.routeReason).toBe("Single focused module");
    expect(model.usage.pricingStatus).toBe("unknown");

    for (const collection of ["events", "tasks", "artifacts", "verifications"]) {
      const response = await harness.app.inject({
        method: "GET",
        url: "/api/orchestrations/" + id + "/" + collection,
      });
      expect(response.statusCode, collection).toBe(200);
      expect(response.json()).toHaveProperty(collection);
    }

    const limited = await harness.app.inject({
      method: "GET",
      url: "/api/orchestrations/" + id + "/events?limit=2",
    });
    expect((limited.json() as { events: unknown[] }).events).toHaveLength(2);

    const badLimit = await harness.app.inject({
      method: "GET",
      url: "/api/orchestrations/" + id + "/events?limit=abc",
    });
    expect(badLimit.statusCode).toBe(400);

    const lateCancel = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/cancel",
    });
    expect(lateCancel.statusCode).toBe(409);
    await harness.app.close();
  });

  it("cancels an active orchestration with 200", async () => {
    const harness = await createHarness();
    const id = await createOrchestration(harness);
    const cancelled = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/cancel",
      payload: { reason: "Changed my mind" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(
      (cancelled.json() as { orchestration: { status: string } }).orchestration.status,
    ).toBe("cancelled");
    await harness.app.close();
  });

  it("confirms and rejects amendments with the documented status codes", async () => {
    const amendment: ContractAmendment = {
      id: "driver",
      orchestrationId: "driver",
      baseContractId: "driver",
      proposedIntent: {
        id: "driver",
        orchestrationId: "driver",
        revision: 0,
        goal: "Add password reset with audit logging",
        requirements: ["Audit every reset"],
        assumptions: [],
        nonGoals: [],
        architectureDecisions: [],
        materialQuestions: [],
        manualExpectations: [],
        createdAt: "driver",
      },
      proposedCriteria: null,
      reason: "The protected check requires an audit record",
      material: true,
      status: "pending",
      createdAt: "driver",
      decidedAt: null,
    };

    const harness = await createHarness();
    harness.driver.outcome = { kind: "needs-user", amendment };
    const id = await createOrchestration(harness);
    await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/confirm",
      payload: { confirm: true },
    });
    await harness.service.whenSettled(id);
    await harness.app.inject({ method: "POST", url: "/api/orchestrations/" + id + "/start" });
    await harness.service.whenSettled(id);

    const model = harness.service.getOrchestration(id);
    expect(model.orchestration.status).toBe("needs-user");
    const amendmentId = model.pendingAmendment?.id ?? "";

    const unknownAmendment = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/amendments/" + UNKNOWN_ID + "/confirm",
    });
    expect(unknownAmendment.statusCode).toBe(404);

    const confirmed = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/amendments/" + amendmentId + "/confirm",
    });
    expect(confirmed.statusCode).toBe(202);
    expect(
      (confirmed.json() as { contract: { version: number } }).contract.version,
    ).toBe(2);
    await harness.service.whenSettled(id);

    const alreadyDecided = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/amendments/" + amendmentId + "/reject",
    });
    expect(alreadyDecided.statusCode).toBe(422);
    await harness.app.close();
  });

  it("rejects an amendment with 200 and returns to confirmation", async () => {
    const harness = await createHarness();
    harness.driver.outcome = {
      kind: "needs-user",
      amendment: {
        id: "driver",
        orchestrationId: "driver",
        baseContractId: "driver",
        proposedIntent: {
          id: "driver",
          orchestrationId: "driver",
          revision: 0,
          goal: "Drop the expiry requirement",
          requirements: [],
          assumptions: [],
          nonGoals: [],
          architectureDecisions: [],
          materialQuestions: [],
          manualExpectations: [],
          createdAt: "driver",
        },
        proposedCriteria: null,
        reason: "The worker wants an easier contract",
        material: true,
        status: "pending",
        createdAt: "driver",
        decidedAt: null,
      },
    };
    const id = await createOrchestration(harness);
    await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/confirm",
      payload: { confirm: true },
    });
    await harness.service.whenSettled(id);
    await harness.app.inject({ method: "POST", url: "/api/orchestrations/" + id + "/start" });
    await harness.service.whenSettled(id);

    const amendmentId = harness.service.getOrchestration(id).pendingAmendment?.id ?? "";
    const rejected = await harness.app.inject({
      method: "POST",
      url: "/api/orchestrations/" + id + "/amendments/" + amendmentId + "/reject",
      payload: { reason: "Keep the original contract" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      (rejected.json() as { orchestration: { status: string } }).orchestration.status,
    ).toBe("awaiting-confirmation");
    await harness.app.close();
  });

  it("inherits the existing bearer-token protection on every new route", async () => {
    const token = "a-strong-orchestration-test-token";
    const harness = await createHarness(token);

    const protectedRoutes: Array<[string, string]> = [
      ["POST", "/api/agents/" + AGENT_ID + "/orchestrations"],
      ["GET", "/api/agents/" + AGENT_ID + "/orchestrations"],
      ["GET", "/api/orchestrations/" + UNKNOWN_ID],
      ["PATCH", "/api/orchestrations/" + UNKNOWN_ID + "/intent"],
      ["POST", "/api/orchestrations/" + UNKNOWN_ID + "/confirm"],
      ["POST", "/api/orchestrations/" + UNKNOWN_ID + "/start"],
      ["POST", "/api/orchestrations/" + UNKNOWN_ID + "/cancel"],
      ["GET", "/api/orchestrations/" + UNKNOWN_ID + "/events"],
      ["GET", "/api/orchestrations/" + UNKNOWN_ID + "/tasks"],
      ["GET", "/api/orchestrations/" + UNKNOWN_ID + "/artifacts"],
      ["GET", "/api/orchestrations/" + UNKNOWN_ID + "/verifications"],
      [
        "POST",
        "/api/orchestrations/" + UNKNOWN_ID + "/amendments/" + UNKNOWN_ID + "/confirm",
      ],
      [
        "POST",
        "/api/orchestrations/" + UNKNOWN_ID + "/amendments/" + UNKNOWN_ID + "/reject",
      ],
    ];

    for (const [method, url] of protectedRoutes) {
      const denied = await harness.app.inject({
        method: method as "GET",
        url,
        payload: {},
      });
      expect(denied.statusCode, method + " " + url).toBe(401);
    }

    const allowed = await harness.app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/orchestrations",
      headers: { authorization: "Bearer " + token },
    });
    expect(allowed.statusCode).toBe(200);
    await harness.app.close();
  });
});
