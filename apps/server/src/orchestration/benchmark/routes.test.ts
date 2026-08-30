import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerBenchmarkRoutes } from "./routes.js";
import type { BenchmarkService } from "./service.js";

describe("benchmark routes", () => {
  it("validates input and returns a persisted record", async () => {
    const app = Fastify();
    const record = { id: "7b35b512-79b2-43a8-9c39-b7ad3eeea786", status: "running" };
    const service = { create: async () => record, get: () => record } as unknown as BenchmarkService;
    registerBenchmarkRoutes(app, service);
    const invalid = await app.inject({ method: "POST", url: "/api/agents/not-an-id/benchmarks", payload: {} });
    expect(invalid.statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: "/api/agents/8f987588-6593-493c-b88d-6fe7fd8c3abc/benchmarks", payload: { prompt: "Build it", criteria: [{ id: "c1", kind: "functional", description: "It works", verification: "visible-test" }] } });
    expect(response.statusCode).toBe(202);
    expect(response.json().benchmark.id).toBe(record.id);
    await app.close();
  });
});
