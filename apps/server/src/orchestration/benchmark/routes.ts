import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contractCriterionSchema } from "../control/service.js";
import type { BenchmarkService } from "./service.js";

const agentIdParams = z.object({ agentId: z.string().uuid() });
const benchmarkIdParams = z.object({ benchmarkId: z.string().uuid() });

const createBenchmarkBody = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  criteria: z.array(contractCriterionSchema).min(1).max(100),
});

/**
 * Registers the benchmark route surface. Standalone — registering it in the
 * real app (with real direct/orchestrated executors wired in) is a Final
 * Assembly step; this plugin only needs a `BenchmarkService` instance,
 * which is fully testable with injected fake executors.
 */
export function registerBenchmarkRoutes(app: FastifyInstance, service: BenchmarkService): void {
  app.post("/api/agents/:agentId/benchmarks", async (request, reply) => {
    const { agentId } = agentIdParams.parse(request.params);
    const body = createBenchmarkBody.parse(request.body);
    const criteria = body.criteria.map((criterion) => ({ ...criterion, id: criterion.id ?? randomUUID() }));
    const benchmark = await service.createBenchmark({ agentId, prompt: body.prompt, criteria });
    return reply.code(202).send({ benchmark });
  });

  app.get("/api/benchmarks/:benchmarkId", async (request) => {
    const { benchmarkId } = benchmarkIdParams.parse(request.params);
    return { benchmark: service.getBenchmark(benchmarkId) };
  });
}
