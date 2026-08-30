import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BudgetPolicy, ContractCriterion } from "../contracts.js";
import type { OrchestrationControlService } from "./service.js";

class RouteValidationError extends Error {
  readonly statusCode = 400;
  readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super("Invalid request");
    this.name = "RouteValidationError";
    this.issues = error.issues;
  }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new RouteValidationError(result.error);
  return result.data;
};

const agentParams = z.object({ agentId: z.string().uuid() });
const orchestrationParams = z.object({ orchestrationId: z.string().uuid() });
const amendmentParams = orchestrationParams.extend({
  amendmentId: z.string().uuid(),
});
const nullableBounded = (maximum: number) =>
  z.number().finite().nonnegative().max(maximum).nullable();
const budgetSchema = z
  .object({
    maxInputTokens: nullableBounded(100_000_000).optional(),
    maxOutputTokens: nullableBounded(20_000_000).optional(),
    maxEstimatedUsd: nullableBounded(100_000).optional(),
    maxModelCalls: z.number().int().nonnegative().max(10_000).optional(),
    maxSteps: z.number().int().nonnegative().max(100_000).optional(),
    maxWorkerAttempts: z.number().int().nonnegative().max(100).optional(),
    maxContextExpansionsPerTask: z.number().int().nonnegative().max(100).optional(),
    maxWallClockMs: z.number().int().nonnegative().max(604_800_000).optional(),
  })
  .strict();
const createBody = z
  .object({
    prompt: z.string().trim().min(1).max(50_000),
    requestedMode: z.enum(["auto", "direct", "orchestrated"]).optional(),
    budget: budgetSchema.optional(),
  })
  .strict();
const revisionBody = z
  .object({
    revision: z.string().trim().min(1).max(20_000).optional(),
    note: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict()
  .refine((body) => Boolean(body.revision ?? body.note), {
    message: "revision or note is required",
  });
const criterionSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
    description: z.string().trim().min(1).max(4_000),
    verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
  })
  .strict();
const confirmBody = z
  .object({
    criteria: z.array(criterionSchema).min(1).max(250).optional(),
    answers: z.array(z.string().trim().min(1).max(4_000)).max(50).optional(),
  })
  .strict();
const amendmentConfirmBody = z.object({
  response: z.string().trim().min(1).max(20_000).optional(),
}).strict();

export function registerOrchestrationRoutes(
  app: FastifyInstance,
  service: OrchestrationControlService,
): void {
  app.post("/api/agents/:agentId/orchestrations", async (request, reply) => {
    const { agentId } = parse(agentParams, request.params);
    const body = parse(createBody, request.body);
    const budget = body.budget
      ? (Object.fromEntries(
          Object.entries(body.budget).filter((entry) => entry[1] !== undefined),
        ) as Partial<BudgetPolicy>)
      : undefined;
    const orchestration = await service.createOrchestration(agentId, {
      prompt: body.prompt,
      requestedMode: body.requestedMode ?? "auto",
      ...(budget ? { budget } : {}),
    });
    return reply.code(202).send({ orchestration });
  });

  app.get("/api/agents/:agentId/orchestrations", async (request) => {
    const { agentId } = parse(agentParams, request.params);
    return { orchestrations: service.listOrchestrations(agentId) };
  });

  app.get("/api/orchestrations/:orchestrationId", async (request) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    return service.getOrchestration(orchestrationId);
  });

  app.patch("/api/orchestrations/:orchestrationId/intent", async (request, reply) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    const body = parse(revisionBody, request.body);
    const orchestration = await service.reviseIntent(
      orchestrationId,
      body.revision ?? body.note!,
    );
    return reply.code(202).send({ orchestration });
  });

  app.post("/api/orchestrations/:orchestrationId/confirm", async (request, reply) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    const body = parse(confirmBody, request.body ?? {});
    const contract = await service.confirm(
      orchestrationId,
      body.criteria as ContractCriterion[] | undefined,
      body.answers,
    );
    return reply.code(202).send({ contract });
  });

  app.post("/api/orchestrations/:orchestrationId/start", async (request, reply) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    const orchestration = await service.start(orchestrationId);
    return reply.code(202).send({ orchestration });
  });

  app.post("/api/orchestrations/:orchestrationId/cancel", async (request, reply) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    const cancelled = await service.cancel(orchestrationId);
    return reply.code(202).send({ cancelled });
  });

  app.get("/api/orchestrations/:orchestrationId/events", async (request) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    return { events: service.getOrchestration(orchestrationId).events };
  });

  app.get("/api/orchestrations/:orchestrationId/tasks", async (request) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    return { tasks: service.getOrchestration(orchestrationId).tasks };
  });

  app.get("/api/orchestrations/:orchestrationId/artifacts", async (request) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    return { artifacts: service.getOrchestration(orchestrationId).artifacts };
  });

  app.get("/api/orchestrations/:orchestrationId/verifications", async (request) => {
    const { orchestrationId } = parse(orchestrationParams, request.params);
    return {
      verifications: service.getOrchestration(orchestrationId).verifications,
    };
  });

  app.post(
    "/api/orchestrations/:orchestrationId/amendments/:amendmentId/confirm",
    async (request, reply) => {
      const { orchestrationId, amendmentId } = parse(amendmentParams, request.params);
      const body = parse(amendmentConfirmBody, request.body ?? {});
      const contract = await service.confirmAmendment(orchestrationId, amendmentId, body.response);
      return reply.code(202).send({ contract });
    },
  );

  app.post(
    "/api/orchestrations/:orchestrationId/amendments/:amendmentId/reject",
    async (request) => {
      const { orchestrationId, amendmentId } = parse(amendmentParams, request.params);
      await service.rejectAmendment(orchestrationId, amendmentId);
      return { rejected: true };
    },
  );
}
