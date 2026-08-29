import Fastify from "fastify";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestrationExecutionDriver } from "../contracts.js";
import { registerOrchestrationRoutes } from "./routes.js";
import { OrchestrationControlService } from "./service.js";
import { OrchestrationStore } from "./store.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const driver: OrchestrationExecutionDriver = {
  async elaborateIntent(input) {
    return {
      draft: {
        id: "draft", orchestrationId: input.orchestrationId, revision: 1,
        goal: "Safe goal", requirements: ["Works"], assumptions: [], nonGoals: [],
        architectureDecisions: ["Stable boundary"], materialQuestions: [],
        manualExpectations: [], createdAt: "now",
      },
      estimate: {
        inputTokenLow: 1, inputTokenHigh: 2, outputTokenLow: 1,
        outputTokenHigh: 2, estimatedUsdLow: null, estimatedUsdHigh: null,
        pricingStatus: "unknown", assumptions: [],
      },
    };
  },
  async plan(input) {
    return {
      selectedMode: "direct", routeReason: "Small task", tasks: [],
      applicationMap: {
        orchestrationId: input.orchestration.id, version: 1, repositoryHash: "hash",
        summary: "map", fileCount: 1, createdAt: new Date().toISOString(),
      },
    };
  },
  async execute() {
    return { kind: "completed", finalOutput: "done" };
  },
  async cancel() {
    return true;
  },
};

async function makeApp(auth = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-routes-"));
  const service = new OrchestrationControlService({
    store: new OrchestrationStore(path.join(directory, "db.json")),
    driver,
    agentAccess: {
      getAgent: (id) => id === AGENT_ID
        ? { id, status: "ready", workspacePath: directory }
        : null,
    },
  });
  await service.initialize();
  const app = Fastify();
  if (auth) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "Bearer test-token") {
        return reply.code(401).send({ error: "Authentication required" });
      }
    });
  }
  registerOrchestrationRoutes(app, service);
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    return reply.code(status).send({ error: error.message });
  });
  return { app, service };
}

describe("orchestration routes", () => {
  it("validates input and maps create/list/read/transition status codes", async () => {
    const { app, service } = await makeApp();
    const malformed = await app.inject({
      method: "POST", url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "", requestedMode: "anything" },
    });
    expect(malformed.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST", url: `/api/agents/${AGENT_ID}/orchestrations`,
      payload: { prompt: "Do work" },
    });
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().orchestration.id as string;
    expect(accepted.json().orchestration.requestedMode).toBe("auto");
    await service.waitForIdle(id);

    const revised = await app.inject({
      method: "PATCH",
      url: `/api/orchestrations/${id}/intent`,
      payload: { note: "Preserve compatibility" },
    });
    expect(revised.statusCode).toBe(202);
    await service.waitForIdle(id);

    const listed = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}/orchestrations` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().orchestrations).toHaveLength(1);

    const illegalStart = await app.inject({ method: "POST", url: `/api/orchestrations/${id}/start` });
    expect(illegalStart.statusCode).toBe(422);
    const confirmed = await app.inject({ method: "POST", url: `/api/orchestrations/${id}/confirm`, payload: {} });
    expect(confirmed.statusCode).toBe(202);
    await service.waitForIdle(id);
    const started = await app.inject({ method: "POST", url: `/api/orchestrations/${id}/start` });
    expect(started.statusCode).toBe(202);
    await service.waitForIdle(id);
    expect((await app.inject({ method: "GET", url: `/api/orchestrations/${id}/events` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/orchestrations/${id}/tasks` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/orchestrations/${id}/artifacts` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/orchestrations/${id}/verifications` })).statusCode).toBe(200);
    await app.close();
  });

  it("returns 404 for unknown IDs and preserves bearer protection when registered after a hook", async () => {
    const { app } = await makeApp(true);
    const denied = await app.inject({ method: "GET", url: `/api/agents/${AGENT_ID}/orchestrations` });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: "GET", url: `/api/agents/${AGENT_ID}/orchestrations`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    const missing = await app.inject({
      method: "GET", url: "/api/orchestrations/22222222-2222-4222-8222-222222222222",
      headers: { authorization: "Bearer test-token" },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
