import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import type { BenchmarkRecord, BenchmarkService } from "./service.js";

/**
 * Fastify plugin for the direct-versus-orchestrated benchmark.
 *
 * The plugin assumes the application's existing bearer-token `onRequest` hook
 * already protects `/api/*`; it deliberately does not add a second
 * authentication mechanism. Final Assembly registers it after that hook.
 *
 * Status codes match the baseline control plane: 202 for accepted asynchronous
 * work, 400 for malformed input, 404 for unknown IDs, 409 for concurrency
 * conflicts. Statuses are resolved inside the handlers so the plugin behaves
 * identically whether or not the host application installs an error handler.
 */

const agentIdParams = z.object({ agentId: z.string().uuid() });
const benchmarkIdParams = z.object({ benchmarkId: z.string().uuid() });

const criterionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: z.string().trim().min(1).max(2_000),
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
});

const boundedTokens = z.number().int().min(0).max(50_000_000);

const budgetSchema = z
  .object({
    maxInputTokens: boundedTokens.nullable(),
    maxOutputTokens: boundedTokens.nullable(),
    maxEstimatedUsd: z.number().min(0).max(10_000).nullable(),
    maxModelCalls: z.number().int().min(1).max(2_000),
    maxSteps: z.number().int().min(1).max(5_000),
    maxWorkerAttempts: z.number().int().min(1).max(20),
    maxContextExpansionsPerTask: z.number().int().min(0).max(20),
    maxWallClockMs: z.number().int().min(1_000).max(6 * 60 * 60_000),
  })
  .partial();

const createBenchmarkBody = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  criteria: z.array(criterionSchema).max(60).optional(),
  budget: budgetSchema.optional(),
  notes: z.string().trim().max(2_000).optional(),
});

function badRequest(error: z.ZodError): { error: string; details: unknown } {
  return { error: "Invalid request", details: error.issues };
}

function statusOf(reason: unknown): number {
  return reason instanceof HttpError ? reason.statusCode : 500;
}

function messageOf(reason: unknown): string {
  if (reason instanceof HttpError) return reason.message;
  return "Benchmark request failed";
}

export function registerBenchmarkRoutes(
  app: FastifyInstance,
  service: BenchmarkService,
): void {
  app.post("/api/agents/:agentId/benchmarks", async (request, reply) => {
    const params = agentIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    const body = createBenchmarkBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send(badRequest(body.error));
    try {
      const benchmark = await service.create(params.data.agentId, body.data);
      return reply.code(202).send({ benchmark });
    } catch (reason) {
      const statusCode = statusOf(reason);
      if (statusCode >= 500) request.log.error(reason);
      return reply.code(statusCode).send({ error: messageOf(reason) });
    }
  });

  app.get("/api/agents/:agentId/benchmarks", async (request, reply) => {
    const params = agentIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    const benchmarks: BenchmarkRecord[] = await service.list(params.data.agentId);
    return reply.code(200).send({ benchmarks });
  });

  app.get("/api/benchmarks/:benchmarkId", async (request, reply) => {
    const params = benchmarkIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    const benchmark = await service.get(params.data.benchmarkId);
    if (!benchmark) return reply.code(404).send({ error: "Benchmark not found" });
    return reply.code(200).send({ benchmark });
  });

  app.post("/api/benchmarks/:benchmarkId/cancel", async (request, reply) => {
    const params = benchmarkIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send(badRequest(params.error));
    try {
      const benchmark = await service.cancel(params.data.benchmarkId);
      return reply.code(202).send({ benchmark });
    } catch (reason) {
      const statusCode = statusOf(reason);
      if (statusCode >= 500) request.log.error(reason);
      return reply.code(statusCode).send({ error: messageOf(reason) });
    }
  });
}
