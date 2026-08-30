import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import { registerBenchmarkRoutes } from "./routes.js";
import { BenchmarkService, type AgentWorkspaceLookup, type BenchmarkExecutor } from "./service.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function fakeExecutor(): BenchmarkExecutor {
  return {
    run: async () => ({
      mode: "direct",
      modelIds: { worker: "ep-default" },
      success: true,
      verificationSummary: "ok",
      totalInputTokens: 10,
      totalCachedInputTokens: 0,
      totalOutputTokens: 5,
      estimatedUsd: null,
      pricingStatus: "unknown",
      wallClockMs: 100,
      modelCalls: 1,
      attempts: 1,
      contextExpansions: 0,
      escalations: 0,
      integrationFailures: 0,
      error: null,
    }),
  };
}

async function buildTestApp(service: BenchmarkService) {
  const app = Fastify();
  registerBenchmarkRoutes(app, service);
  app.setErrorHandler((error, _request, reply) => {
    const validationError = error instanceof z.ZodError;
    const statusCode = error instanceof HttpError ? error.statusCode : validationError ? 400 : 500;
    return reply.code(statusCode).send({ error: error.message });
  });
  return app;
}

const AGENT_ID = randomUUID();

describe("benchmark HTTP routes", () => {
  it("creates a benchmark with 202 and fetches it via GET", async () => {
    const workspace = await tempDir("bench-route-source-");
    await writeFile(path.join(workspace, "a.ts"), "x");
    const scratchRoot = await tempDir("bench-route-scratch-");
    const lookup: AgentWorkspaceLookup = { getWorkspacePath: (id) => (id === AGENT_ID ? workspace : null) };
    const service = new BenchmarkService(lookup, fakeExecutor(), fakeExecutor(), scratchRoot);
    const app = await buildTestApp(service);

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/benchmarks`,
      payload: {
        prompt: "Add password reset",
        criteria: [{ kind: "functional", description: "Add reset endpoint", verification: "visible-test" }],
      },
    });
    expect(created.statusCode).toBe(202);
    const benchmarkId = created.json().benchmark.id as string;

    await service.waitForPendingWork(benchmarkId);

    const fetched = await app.inject({ method: "GET", url: `/api/benchmarks/${benchmarkId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().benchmark.status).toBe("completed");
    await app.close();
  });

  it("returns 404 for an unknown agent and an unknown benchmark", async () => {
    const workspace = await tempDir("bench-route-source-");
    const scratchRoot = await tempDir("bench-route-scratch-");
    const lookup: AgentWorkspaceLookup = { getWorkspacePath: () => null };
    const service = new BenchmarkService(lookup, fakeExecutor(), fakeExecutor(), scratchRoot);
    const app = await buildTestApp(service);

    const missingAgent = await app.inject({
      method: "POST",
      url: `/api/agents/${randomUUID()}/benchmarks`,
      payload: { prompt: "x", criteria: [{ kind: "functional", description: "x", verification: "manual" }] },
    });
    expect(missingAgent.statusCode).toBe(404);

    const missingBenchmark = await app.inject({ method: "GET", url: `/api/benchmarks/${randomUUID()}` });
    expect(missingBenchmark.statusCode).toBe(404);
    await app.close();
  });

  it("returns 400 for a malformed create request", async () => {
    const workspace = await tempDir("bench-route-source-");
    const scratchRoot = await tempDir("bench-route-scratch-");
    const lookup: AgentWorkspaceLookup = { getWorkspacePath: () => workspace };
    const service = new BenchmarkService(lookup, fakeExecutor(), fakeExecutor(), scratchRoot);
    const app = await buildTestApp(service);

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${AGENT_ID}/benchmarks`,
      payload: { prompt: "", criteria: [] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
