import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerBenchmarkRoutes } from "./routes.js";
import { BenchmarkService } from "./service.js";
import type { BenchmarkArm, BenchmarkExecutor } from "./service.js";
import {
  FakeAgentPort,
  FakeWorkspaceProvider,
  RecordingExecutor,
  result,
} from "./fixtures.test.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a-strong-test-token";

/**
 * The plugin relies on the host application's bearer-token hook. This mirrors
 * the hook in `apps/server/src/app.ts` so the test proves the routes stay
 * protected once Final Assembly registers them behind it.
 */
async function testApp(
  service: BenchmarkService,
  authToken = "",
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (!authToken || !request.url.startsWith("/api/")) return;
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = Buffer.from(authToken);
    const provided = Buffer.from(candidate);
    const valid =
      provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!valid) return reply.code(401).send({ error: "Authentication required" });
  });
  registerBenchmarkRoutes(app, service);
  await app.ready();
  return app;
}

function service(executors?: Partial<Record<BenchmarkArm, BenchmarkExecutor>>) {
  const direct =
    executors?.direct ??
    new RecordingExecutor("direct", {
      kind: "result",
      result: result({ executionId: "exec-direct" }),
    });
  const orchestrated =
    executors?.orchestrated ??
    new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({ executionId: "exec-orchestrated" }),
    });
  return new BenchmarkService({
    agents: new FakeAgentPort([
      { id: AGENT_ID, status: "ready", workspacePath: "/workspaces/" + AGENT_ID },
    ]),
    workspaces: new FakeWorkspaceProvider(),
    executors: { direct, orchestrated },
  });
}

describe("benchmark routes", () => {
  it("accepts a benchmark with 202 and returns it by ID", async () => {
    const benchmarks = service();
    const app = await testApp(benchmarks);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
      payload: { prompt: "Add a health endpoint and a test." },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json().benchmark.id as string;
    await benchmarks.whenSettled(id);

    const fetched = await app.inject({ method: "GET", url: "/api/benchmarks/" + id });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().benchmark.status).toBe("completed");
    // Quality is present before any cost claim.
    expect(fetched.json().benchmark.comparison.qualityVerdict).toBe("both-passed");

    const listed = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().benchmarks).toHaveLength(1);
    await app.close();
  });

  it("rejects malformed input with 400 and unknown IDs with 404", async () => {
    const app = await testApp(service());

    const badBody = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
      payload: { prompt: "" },
    });
    expect(badBody.statusCode).toBe(400);

    const badBudget = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
      payload: { prompt: "ok", budget: { maxModelCalls: -5 } },
    });
    expect(badBudget.statusCode).toBe(400);

    const badParam = await app.inject({
      method: "GET",
      url: "/api/benchmarks/not-a-uuid",
    });
    expect(badParam.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/api/benchmarks/66666666-6666-4666-8666-666666666666",
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("maps a stopped Agent to 409 and an unknown Agent to 404", async () => {
    const benchmarks = new BenchmarkService({
      agents: new FakeAgentPort([
        { id: AGENT_ID, status: "stopped", workspacePath: "/workspaces/" + AGENT_ID },
      ]),
      workspaces: new FakeWorkspaceProvider(),
      executors: {
        direct: new RecordingExecutor("direct", {
          kind: "result",
          result: result({ executionId: "exec-direct" }),
        }),
        orchestrated: new RecordingExecutor("orchestrated", {
          kind: "result",
          result: result({ executionId: "exec-orchestrated" }),
        }),
      },
    });
    const app = await testApp(benchmarks);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
      payload: { prompt: "Start me first." },
    });
    expect(conflict.statusCode).toBe(409);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/agents/77777777-7777-4777-8777-777777777777/benchmarks",
      payload: { prompt: "Unknown agent." },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("cancels a running benchmark through the route", async () => {
    const benchmarks = service({
      direct: new RecordingExecutor("direct", { kind: "hang" }),
    });
    const app = await testApp(benchmarks);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
      payload: { prompt: "Hang." },
    });
    const id = created.json().benchmark.id as string;

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/benchmarks/" + id + "/cancel",
    });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json().benchmark.status).toBe("cancelled");
    await app.close();
  });

  it("stays behind the existing shared bearer token", async () => {
    const app = await testApp(service(), TOKEN);
    const denied = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/benchmarks",
      headers: { authorization: "Bearer " + TOKEN },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});
