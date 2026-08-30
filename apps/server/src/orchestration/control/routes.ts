import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BUDGET_LIMITS } from "./budget-ledger.js";
import type { OrchestrationControlService } from "./service.js";

/**
 * Fastify route plugin for the orchestration control plane.
 *
 * Registered by Final Assembly *after* the application's existing bearer-token
 * `onRequest` hook, so every `/api/*` route here inherits that protection. No
 * second authentication mechanism is introduced.
 *
 * Status codes:
 *   202 accepted asynchronous work
 *   400 malformed input (Zod)
 *   404 unknown orchestration, Agent or amendment
 *   409 illegal transition or concurrency conflict
 *   422 semantically invalid confirmation or amendment decision
 * Budget exhaustion is a persisted domain state, never an HTTP failure.
 */

const agentIdParams = z.object({ agentId: z.string().uuid() });
const orchestrationIdParams = z.object({ orchestrationId: z.string().uuid() });
const amendmentParams = z.object({
  orchestrationId: z.string().uuid(),
  amendmentId: z.string().uuid(),
});

const budgetOverrideSchema = z
  .object({
    maxInputTokens: z
      .number()
      .int()
      .min(1)
      .max(BUDGET_LIMITS.maxInputTokens)
      .nullable()
      .optional(),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .max(BUDGET_LIMITS.maxOutputTokens)
      .nullable()
      .optional(),
    maxEstimatedUsd: z
      .number()
      .min(0)
      .max(BUDGET_LIMITS.maxEstimatedUsd)
      .nullable()
      .optional(),
    maxModelCalls: z.number().int().min(1).max(BUDGET_LIMITS.maxModelCalls).optional(),
    maxSteps: z.number().int().min(1).max(BUDGET_LIMITS.maxSteps).optional(),
    maxWorkerAttempts: z
      .number()
      .int()
      .min(1)
      .max(BUDGET_LIMITS.maxWorkerAttempts)
      .optional(),
    maxContextExpansionsPerTask: z
      .number()
      .int()
      .min(0)
      .max(BUDGET_LIMITS.maxContextExpansionsPerTask)
      .optional(),
    maxWallClockMs: z
      .number()
      .int()
      .min(1_000)
      .max(BUDGET_LIMITS.maxWallClockMs)
      .optional(),
  })
  .strict();

const createOrchestrationBody = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  requestedMode: z.enum(["auto", "direct", "orchestrated"]).default("auto"),
  budget: budgetOverrideSchema.optional(),
});

const reviseIntentBody = z.object({
  feedback: z.string().trim().min(1).max(10_000),
});

const criterionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: z.string().trim().min(1).max(2_000),
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
});

const confirmBody = z.object({
  confirm: z.literal(true),
  answers: z.array(z.string().max(4_000)).max(50).optional(),
  criteria: z.array(criterionSchema).max(200).optional(),
});

const cancelBody = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .optional();

const rejectBody = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .optional();

const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
  afterEventId: z.string().uuid().optional(),
});

export function registerOrchestrationRoutes(
  app: FastifyInstance,
  service: OrchestrationControlService,
): void {
  app.post("/api/agents/:agentId/orchestrations", async (request, reply) => {
    const { agentId } = agentIdParams.parse(request.params);
    const body = createOrchestrationBody.parse(request.body ?? {});
    const orchestration = await service.createOrchestration({
      agentId,
      prompt: body.prompt,
      requestedMode: body.requestedMode,
      ...(body.budget === undefined ? {} : { budget: body.budget }),
    });
    return reply.code(202).send({ orchestration });
  });

  app.get("/api/agents/:agentId/orchestrations", async (request) => {
    const { agentId } = agentIdParams.parse(request.params);
    return { orchestrations: await service.listOrchestrations(agentId) };
  });

  app.get("/api/orchestrations/:orchestrationId", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    return service.getOrchestration(orchestrationId);
  });

  app.patch("/api/orchestrations/:orchestrationId/intent", async (request, reply) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const body = reviseIntentBody.parse(request.body ?? {});
    const orchestration = await service.reviseIntent(orchestrationId, body.feedback);
    return reply.code(202).send({ orchestration });
  });

  app.post("/api/orchestrations/:orchestrationId/confirm", async (request, reply) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const body = confirmBody.parse(request.body ?? {});
    const result = await service.confirmIntent(orchestrationId, {
      confirm: body.confirm,
      ...(body.answers === undefined ? {} : { answers: body.answers }),
      ...(body.criteria === undefined ? {} : { criteria: body.criteria }),
    });
    return reply.code(202).send(result);
  });

  app.post("/api/orchestrations/:orchestrationId/start", async (request, reply) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const orchestration = await service.startExecution(orchestrationId);
    return reply.code(202).send({ orchestration });
  });

  app.post("/api/orchestrations/:orchestrationId/cancel", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const body = cancelBody.parse(request.body ?? undefined);
    const orchestration = await service.cancel(
      orchestrationId,
      body?.reason ?? "Cancelled by user",
    );
    return { orchestration };
  });

  app.get("/api/orchestrations/:orchestrationId/events", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const query = eventsQuery.parse(request.query ?? {});
    return {
      events: service.listEvents(orchestrationId, {
        limit: query.limit,
        afterEventId: query.afterEventId,
      }),
    };
  });

  app.get("/api/orchestrations/:orchestrationId/tasks", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    return { tasks: service.listTasks(orchestrationId) };
  });

  app.get("/api/orchestrations/:orchestrationId/artifacts", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    return { artifacts: service.listArtifacts(orchestrationId) };
  });

  app.get("/api/orchestrations/:orchestrationId/verifications", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    return { verifications: service.listVerifications(orchestrationId) };
  });

  app.post(
    "/api/orchestrations/:orchestrationId/amendments/:amendmentId/confirm",
    async (request, reply) => {
      const { orchestrationId, amendmentId } = amendmentParams.parse(request.params);
      const result = await service.confirmAmendment(orchestrationId, amendmentId);
      return reply.code(202).send(result);
    },
  );

  app.post(
    "/api/orchestrations/:orchestrationId/amendments/:amendmentId/reject",
    async (request) => {
      const { orchestrationId, amendmentId } = amendmentParams.parse(request.params);
      const body = rejectBody.parse(request.body ?? undefined);
      const orchestration = await service.rejectAmendment(
        orchestrationId,
        amendmentId,
        body?.reason ?? "Amendment rejected by user",
      );
      return { orchestration };
    },
  );
}
