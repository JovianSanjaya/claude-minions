import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BenchmarkService } from "./service.js";

class BenchmarkRouteValidationError extends Error {
  readonly statusCode = 400;
  constructor() { super("Invalid benchmark request"); }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new BenchmarkRouteValidationError();
  return result.data;
};

const agentParams = z.object({ agentId: z.string().uuid() });
const benchmarkParams = z.object({ benchmarkId: z.string().uuid() });
const criterion = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: z.string().trim().min(1).max(4_000),
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
}).strict();
const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  criteria: z.array(criterion).min(1).max(250),
}).strict();

export function registerBenchmarkRoutes(app: FastifyInstance, service: BenchmarkService): void {
  app.post("/api/agents/:agentId/benchmarks", async (request, reply) => {
    const { agentId } = parse(agentParams, request.params);
    const body = parse(bodySchema, request.body);
    return reply.code(202).send({ benchmark: await service.create(agentId, body.prompt, body.criteria) });
  });
  app.get("/api/benchmarks/:benchmarkId", async (request) => {
    const { benchmarkId } = parse(benchmarkParams, request.params);
    return { benchmark: service.get(benchmarkId) };
  });
}
