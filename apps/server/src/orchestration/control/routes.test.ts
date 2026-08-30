import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import type {
  ClarificationQuestion,
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
import { registerOrchestrationRoutes } from "./routes.js";
import type { AgentAccessPort, AgentSnapshot } from "./service.js";
import { OrchestrationControlService } from "./service.js";
import { OrchestrationStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
    consequenceIfWrong: "Tokens could remain valid too long",
    options: [
      { id: "opt-1h", label: "1 hour", resolutionText: "Reset tokens expire after 1 hour", delegate: false },
      { id: "opt-24h", label: "24 hours", resolutionText: "Reset tokens expire after 24 hours", delegate: false },
    ],
    category: "requirements",
    relatedClaimIds: [],
    ...overrides,
  };
}

function draftSkeleton(overrides: Partial<IntentDraft> = {}): IntentDraft {
  return {
    id: "",
    orchestrationId: "placeholder",
    revision: 0,
    goal: "Add password reset",
    requirements: [claim("Users can request a reset email")],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    manualExpectations: [],
    openQuestions: [],
    createdAt: "placeholder",
    ...overrides,
  };
}

function estimateSkeleton(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    inputTokenLow: 100,
    inputTokenHigh: 500,
    outputTokenLow: 50,
    outputTokenHigh: 200,
    estimatedUsdLow: null,
    estimatedUsdHigh: null,
    pricingStatus: "unknown",
    assumptions: [],
    ...overrides,
  };
}

function defaultPlan(input: PlanInput): PlanResult {
  return {
    selectedMode: "direct",
    routeReason: "single small task",
    tasks: [],
    applicationMap: {
      orchestrationId: input.orchestration.id,
      version: 1,
      repositoryHash: "fake-hash",
      summary: "root",
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
      overrides.elaborate ?? (async () => ({ draft: draftSkeleton(), estimate: estimateSkeleton() })),
    plan: overrides.plan ?? (async (input) => defaultPlan(input)),
    execute: overrides.execute ?? (async () => ({ kind: "completed", finalOutput: "done" })),
    cancel: overrides.cancel ?? (async () => true),
  };
}

/**
 * A minimal harness mirroring the error-mapping behavior of the host app's
 * setErrorHandler (see apps/server/src/app.ts). Task 1 does not own app.ts,
 * so this replicates just enough of it to test the plugin's HTTP contract
 * standalone, per the spec's requirement that each task be independently
 * testable before the others are merged.
 */
async function buildTestApp(
  service: OrchestrationControlService,
): Promise<FastifyInstance> {
  const app = Fastify();
  registerOrchestrationRoutes(app, service);
  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });
  return app;
}

async function createHarness(
  agents: Record<string, AgentSnapshot> = {
    [AGENT_ID]: {
      id: AGENT_ID,
      status: "ready",
      workspacePath: "/workspaces/agent-1",
    },
  },
  driver: OrchestrationExecutionDriver = createFakeDriver(),
) {
  const root = await mkdtemp(path.join(tmpdir(), "orchestration-routes-test-"));
  temporaryDirectories.push(root);
  const store = new OrchestrationStore(path.join(root, "orchestrations.json"));
  await store.initialize();
  const agentAccess: AgentAccessPort = { getAgent: (id) => agents[id] ?? null };
  const service = new OrchestrationControlService(store, agentAccess, driver);
  const app = await buildTestApp(service);
  return { app, service };
}

const AGENT_ID = randomUUID();

describe("orchestration control-plane HTTP routes", () => {
  it("creates an orchestration with 202 and later returns it via GET", async () => {
    const { app, service } = await createHarness();

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow" },
    });
    expect(created.statusCode).toBe(202);
    const { orchestration } = created.json();
    expect(orchestration.status).toBe("drafting-intent");

    await service.waitForPendingWork(orchestration.id);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${orchestration.id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().orchestration.status).toBe("awaiting-confirmation");

    const list = await app.inject({
      method: "GET",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().orchestrations).toHaveLength(1);

    await app.close();
  });

  it("returns 400 for a malformed create request", async () => {
    const { app } = await createHarness();
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for an unknown Agent on create and an unknown orchestration on GET", async () => {
    const { app } = await createHarness();
    const missingAgent = await app.inject({
      method: "POST",
      url: `/api/agents/${randomUUID()}/orchestrations`,
      payload: { prompt: "do work" },
    });
    expect(missingAgent.statusCode).toBe(404);

    const missingOrchestration = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${randomUUID()}`,
    });
    expect(missingOrchestration.statusCode).toBe(404);
    await app.close();
  });

  it("returns 409 when a second orchestration is created for an already-active Agent", async () => {
    const { app } = await createHarness(
      undefined,
      createFakeDriver({ elaborate: () => new Promise<never>(() => undefined) }),
    );
    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "first task" },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "second task" },
    });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it("walks intent revise -> confirm -> amendment confirm through HTTP with correct status codes", async () => {
    let call = 0;
    const driver = createFakeDriver({
      elaborate: async () => {
        call += 1;
        if (call === 1) {
          return {
            draft: draftSkeleton({ openQuestions: [question()] }),
            estimate: estimateSkeleton(),
          };
        }
        return { draft: draftSkeleton(), estimate: estimateSkeleton() };
      },
      // proposeAmendment is only legal while status is "planning" (i.e.
      // before the automatic post-confirm plan() resolves) or during
      // execution — hang plan() so this HTTP round-trip lands there
      // deterministically instead of racing the background planning task.
      plan: () => new Promise<never>(() => undefined),
    });
    const { app, service } = await createHarness(undefined, driver);

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow" },
    });
    const orchestrationId = created.json().orchestration.id as string;
    await service.waitForPendingWork(orchestrationId);

    const blockedConfirm = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/confirm`,
    });
    expect(blockedConfirm.statusCode).toBe(422);

    const revise = await app.inject({
      method: "PATCH",
      url: `/api/orchestrations/${orchestrationId}/intent`,
      payload: { note: "Use a 1 hour expiry" },
    });
    expect(revise.statusCode).toBe(202);
    await service.waitForPendingWork(orchestrationId);

    const confirm = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/confirm`,
    });
    expect(confirm.statusCode).toBe(200);
    const contract = confirm.json().contract;
    expect(contract.version).toBe(1);
    const criteriaKinds = new Set(
      (contract.criteria as Array<{ kind: string }>).map((item) => item.kind),
    );
    expect(criteriaKinds.has("functional")).toBe(true);
    expect(criteriaKinds.has("runtime")).toBe(true);

    const proposeAmendment = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/amendments`,
      payload: { reason: "Tokens must be single-use", requirements: ["Tokens can only be used once"] },
    });
    expect(proposeAmendment.statusCode).toBe(201);
    const amendmentId = proposeAmendment.json().amendment.id as string;

    const confirmAmendment = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/amendments/${amendmentId}/confirm`,
    });
    expect(confirmAmendment.statusCode).toBe(200);
    expect(confirmAmendment.json().contract.version).toBe(2);

    await app.close();
  });

  it("answers a material clarification question over HTTP and then allows confirmation", async () => {
    const q = question();
    const driver = createFakeDriver({
      elaborate: async () => ({ draft: draftSkeleton({ openQuestions: [q] }), estimate: estimateSkeleton() }),
    });
    const { app, service } = await createHarness(undefined, driver);
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow" },
    });
    const orchestrationId = created.json().orchestration.id as string;
    await service.waitForPendingWork(orchestrationId);

    const badAnswer = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/intent/questions/${q.id}/answer`,
      payload: {},
    });
    expect(badAnswer.statusCode).toBe(400);

    const answer = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/intent/questions/${q.id}/answer`,
      payload: { optionId: "opt-1h" },
    });
    expect(answer.statusCode).toBe(200);

    const confirm = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/confirm`,
    });
    expect(confirm.statusCode).toBe(200);
    await service.waitForPendingWork(orchestrationId);
    await app.close();
  });

  it("returns 409 for a reject on an amendment that is already confirmed", async () => {
    // proposeAmendment requires status "planning"; hang plan() so the
    // orchestration stays there deterministically after /confirm instead of
    // racing the background planning task to "ready".
    const { app, service } = await createHarness(undefined, createFakeDriver({ plan: () => new Promise<never>(() => undefined) }));
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow" },
    });
    const orchestrationId = created.json().orchestration.id as string;
    await service.waitForPendingWork(orchestrationId);
    await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/confirm` });

    const propose = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/amendments`,
      payload: { reason: "change" },
    });
    const amendmentId = propose.json().amendment.id as string;

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/amendments/${amendmentId}/confirm`,
    });
    expect(confirmed.statusCode).toBe(200);

    const rejectAfterConfirm = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/amendments/${amendmentId}/reject`,
    });
    expect(rejectAfterConfirm.statusCode).toBe(409);
    await app.close();
  });

  it("returns 422 when confirmation would exceed the configured hard budget", async () => {
    const driver = createFakeDriver({
      elaborate: async () => ({ draft: draftSkeleton(), estimate: estimateSkeleton({ inputTokenLow: 5000 }) }),
    });
    const { app, service } = await createHarness(undefined, driver);
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow", budget: { maxInputTokens: 10 } },
    });
    const orchestrationId = created.json().orchestration.id as string;
    await service.waitForPendingWork(orchestrationId);

    const confirm = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/confirm`,
    });
    expect(confirm.statusCode).toBe(422);
    await app.close();
  });

  it("rejects params that are not UUIDs with a 400", async () => {
    const { app } = await createHarness();
    const response = await app.inject({
      method: "GET",
      url: "/api/orchestrations/not-a-uuid",
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("starts execution, publishes evidence, and exposes it through the events/tasks/artifacts/verifications routes", async () => {
    const { app, service } = await createHarness();
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow" },
    });
    const orchestrationId = created.json().orchestration.id as string;
    await service.waitForPendingWork(orchestrationId);
    await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/confirm` });
    await service.waitForPendingWork(orchestrationId); // background planning: planning -> ready

    const start = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/start`,
    });
    expect(start.statusCode).toBe(202);
    await service.waitForPendingWork(orchestrationId);

    const fetched = await app.inject({ method: "GET", url: `/api/orchestrations/${orchestrationId}` });
    expect(fetched.json().orchestration.status).toBe("completed");

    const events = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${orchestrationId}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.length).toBeGreaterThan(0);

    const tasks = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${orchestrationId}/tasks`,
    });
    expect(tasks.statusCode).toBe(200);

    const artifacts = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${orchestrationId}/artifacts`,
    });
    expect(artifacts.statusCode).toBe(200);

    const verifications = await app.inject({
      method: "GET",
      url: `/api/orchestrations/${orchestrationId}/verifications`,
    });
    expect(verifications.statusCode).toBe(200);

    await app.close();
  });

  it("cancels a running orchestration via HTTP", async () => {
    const driver = createFakeDriver({ execute: () => new Promise<never>(() => undefined) });
    const { app, service } = await createHarness(undefined, driver);
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Add password reset flow" },
    });
    const orchestrationId = created.json().orchestration.id as string;
    await service.waitForPendingWork(orchestrationId);
    await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/confirm` });
    await service.waitForPendingWork(orchestrationId); // background planning: planning -> ready
    await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/start` });

    const cancel = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${orchestrationId}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().orchestration.status).toBe("cancelled");
    await app.close();
  });
});
