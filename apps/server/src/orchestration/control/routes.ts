import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { budgetPolicyOverrideSchema } from "./budget-ledger.js";
import { criteriaOverrideSchema } from "./service.js";
import type { OrchestrationControlService } from "./service.js";

const agentIdParams = z.object({ agentId: z.string().uuid() });
const orchestrationIdParams = z.object({ orchestrationId: z.string().uuid() });
const amendmentParams = z.object({
  orchestrationId: z.string().uuid(),
  amendmentId: z.string().uuid(),
});

const createOrchestrationBody = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  requestedMode: z.enum(["auto", "direct", "orchestrated"]).optional(),
  budget: budgetPolicyOverrideSchema.optional(),
});

const reviseIntentBody = z.object({
  note: z.string().trim().min(1).max(10_000),
});

const confirmIntentBody = z
  .object({ criteria: criteriaOverrideSchema.optional() })
  .optional();

const proposeAmendmentBody = z.object({
  reason: z.string().trim().min(1).max(2000),
  goal: z.string().trim().min(1).max(2000).optional(),
  requirements: z.array(z.string().trim().min(1).max(2000)).optional(),
  assumptions: z.array(z.string().trim().min(1).max(2000)).optional(),
  nonGoals: z.array(z.string().trim().min(1).max(2000)).optional(),
  architectureDecisions: z.array(z.string().trim().min(1).max(2000)).optional(),
  materialQuestions: z.array(z.string().trim().min(1).max(2000)).optional(),
  manualExpectations: z.array(z.string().trim().min(1).max(2000)).optional(),
  criteria: criteriaOverrideSchema.optional(),
});

/**
 * Registers the subset of the frozen orchestration control-plane route
 * surface that this restricted build implements: intent draft/revision/
 * confirmation, immutable contract versions/amendments, and the estimate
 * shown before a hard-budget-gated confirmation. Routes covering execution,
 * task/artifact/verification evidence, and cancellation are out of scope
 * here (see docs/handoffs/task-1-control-plane.md) and are left for the
 * fuller Task 1 build.
 *
 * Assumes the host app's existing bearer-token hook already protects
 * `/api/*`; this plugin adds no separate authentication mechanism.
 */
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  service: OrchestrationControlService,
): void {
  app.post("/api/agents/:agentId/orchestrations", async (request, reply) => {
    const { agentId } = agentIdParams.parse(request.params);
    const body = createOrchestrationBody.parse(request.body);
    const orchestration = await service.createOrchestration({
      agentId,
      prompt: body.prompt,
      requestedMode: body.requestedMode,
      budget: body.budget,
    });
    return reply.code(202).send({ orchestration });
  });

  app.get("/api/agents/:agentId/orchestrations", async (request) => {
    const { agentId } = agentIdParams.parse(request.params);
    return { orchestrations: service.listOrchestrations(agentId) };
  });

  app.get("/api/orchestrations/:orchestrationId", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    return service.getReadModel(orchestrationId);
  });

  app.patch("/api/orchestrations/:orchestrationId/intent", async (request, reply) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const body = reviseIntentBody.parse(request.body);
    const orchestration = await service.reviseIntent(orchestrationId, body.note);
    return reply.code(202).send({ orchestration });
  });

  app.post("/api/orchestrations/:orchestrationId/confirm", async (request) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const body = confirmIntentBody.parse(request.body ?? {});
    const contract = await service.confirmIntent({
      orchestrationId,
      criteria: body?.criteria,
    });
    return { contract };
  });

  app.post("/api/orchestrations/:orchestrationId/amendments", async (request, reply) => {
    const { orchestrationId } = orchestrationIdParams.parse(request.params);
    const body = proposeAmendmentBody.parse(request.body);
    const amendment = await service.proposeAmendment({ orchestrationId, ...body });
    return reply.code(201).send({ amendment });
  });

  app.post(
    "/api/orchestrations/:orchestrationId/amendments/:amendmentId/confirm",
    async (request) => {
      const { orchestrationId, amendmentId } = amendmentParams.parse(request.params);
      const contract = await service.confirmAmendment(orchestrationId, amendmentId);
      return { contract };
    },
  );

  app.post(
    "/api/orchestrations/:orchestrationId/amendments/:amendmentId/reject",
    async (request) => {
      const { orchestrationId, amendmentId } = amendmentParams.parse(request.params);
      const amendment = await service.rejectAmendment(orchestrationId, amendmentId);
      return { amendment };
    },
  );
}
