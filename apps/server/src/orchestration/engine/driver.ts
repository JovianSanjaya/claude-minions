import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentRunner } from "../../types.js";
import type {
  ClarificationQuestion,
  ContractAmendment,
  CostEstimate,
  ExecuteInput,
  ExecutionOutcome,
  IntentClaim,
  IntentDraft,
  ModelRole,
  OrchestrationExecutionDriver,
  OrchestrationTask,
  PlanInput,
  PlanResult,
} from "../contracts.js";
import { buildApplicationMap, type ApplicationMap } from "./application-map.js";
import { createArtifactRegistry } from "./artifact-registry.js";
import { buildContextPacket } from "./context-broker.js";
import { buildFailurePacket, classifyFailure } from "./failure-packet.js";
import { integrate, type WorkerResult } from "./integrator.js";
import { decideRoute, type RouteDecision } from "./router.js";
import { BudgetDeniedError, callRole, callRoleStructured, describeError, type RoleExecutorDeps } from "./role-executor.js";
import type { CheckDefinition, CheckRunner } from "./verification.js";
import { allPassed, runChecks } from "./verification.js";
import { buildManifest, cleanupTaskWorkspace } from "./worker-workspaces.js";
import { runWorkerLoop } from "./worker-loop.js";

export interface EngineConfig {
  runner: AgentRunner;
  modelIds: Partial<Record<ModelRole, string>>;
  defaultModelId: string;
  /** Trusted, orchestration-scoped root for isolated worker/staging workspace copies. */
  scratchRoot: string;
  checkRunner: CheckRunner;
  protectedChecks: CheckDefinition[];
  globalChecks: CheckDefinition[];
}

const claimSchema = z.object({
  text: z.string().trim().min(1),
  provenance: z.enum(["user-explicit", "planner-inferred", "repository-derived", "user-delegated"]),
  materiality: z.enum(["trivial", "material"]).default("trivial"),
  rationale: z.string().trim().min(1).nullable().default(null),
});

const clarificationOptionSchema = z.object({
  label: z.string().trim().min(1),
  resolutionText: z.string().trim().min(1),
  delegate: z.boolean().default(false),
});

const clarificationQuestionSchema = z.object({
  prompt: z.string().trim().min(1),
  materiality: z.enum(["trivial", "material"]),
  consequenceIfWrong: z.string().trim().min(1),
  category: z.enum(["requirements", "assumptions", "nonGoals", "architectureDecisions", "manualExpectations"]),
  options: z.array(clarificationOptionSchema).min(1),
});

const elaborationOutputSchema = z.object({
  goal: z.string().trim().min(1),
  requirements: z.array(claimSchema).default([]),
  assumptions: z.array(claimSchema).default([]),
  nonGoals: z.array(claimSchema).default([]),
  architectureDecisions: z.array(claimSchema).default([]),
  manualExpectations: z.array(claimSchema).default([]),
  openQuestions: z.array(clarificationQuestionSchema).default([]),
  estimate: z.object({
    inputTokenLow: z.number().int().nonnegative(),
    inputTokenHigh: z.number().int().nonnegative(),
    outputTokenLow: z.number().int().nonnegative(),
    outputTokenHigh: z.number().int().nonnegative(),
    assumptions: z.array(z.string()).default([]),
  }),
});
type ElaborationOutput = z.infer<typeof elaborationOutputSchema>;

function toClaim(input: z.infer<typeof claimSchema>): IntentClaim {
  return {
    id: randomUUID(),
    text: input.text,
    provenance: input.provenance,
    materiality: input.materiality,
    rationale: input.rationale,
    supersedes: null,
  };
}

function toQuestion(input: z.infer<typeof clarificationQuestionSchema>): ClarificationQuestion {
  return {
    id: randomUUID(),
    prompt: input.prompt,
    materiality: input.materiality,
    consequenceIfWrong: input.consequenceIfWrong,
    category: input.category,
    relatedClaimIds: [],
    options: input.options.map((option) => ({
      id: randomUUID(),
      label: option.label,
      resolutionText: option.resolutionText,
      delegate: option.delegate,
    })),
  };
}

function toIntentDraft(orchestrationId: string, value: ElaborationOutput): IntentDraft {
  return {
    id: randomUUID(),
    orchestrationId,
    revision: 0,
    goal: value.goal,
    requirements: value.requirements.map(toClaim),
    assumptions: value.assumptions.map(toClaim),
    nonGoals: value.nonGoals.map(toClaim),
    architectureDecisions: value.architectureDecisions.map(toClaim),
    manualExpectations: value.manualExpectations.map(toClaim),
    openQuestions: value.openQuestions.map(toQuestion),
    createdAt: new Date().toISOString(),
  };
}

function toEstimate(value: ElaborationOutput): CostEstimate {
  return {
    inputTokenLow: value.estimate.inputTokenLow,
    inputTokenHigh: value.estimate.inputTokenHigh,
    outputTokenLow: value.estimate.outputTokenLow,
    outputTokenHigh: value.estimate.outputTokenHigh,
    // Dollar pricing is a control-plane concern applied against actual committed
    // usage (see budget-ledger.ts); the driver never fabricates a dollar estimate.
    estimatedUsdLow: null,
    estimatedUsdHigh: null,
    pricingStatus: "unknown",
    assumptions: value.estimate.assumptions,
  };
}

const ELABORATION_SHAPE_HINT = JSON.stringify({
  goal: "string",
  requirements: [{ text: "string", provenance: "user-explicit|planner-inferred|repository-derived", materiality: "trivial|material", rationale: "string|null" }],
  assumptions: "same shape as requirements",
  nonGoals: "same shape as requirements",
  architectureDecisions: "same shape as requirements",
  manualExpectations: "same shape as requirements",
  openQuestions: [
    {
      prompt: "string",
      materiality: "trivial|material",
      consequenceIfWrong: "string",
      category: "requirements|assumptions|nonGoals|architectureDecisions|manualExpectations",
      options: [{ label: "string", resolutionText: "string", delegate: "boolean" }],
    },
  ],
  estimate: { inputTokenLow: 0, inputTokenHigh: 0, outputTokenLow: 0, outputTokenHigh: 0, assumptions: ["string"] },
});

function buildElaborationPrompt(
  prompt: string,
  priorDraft: IntentDraft | null,
  map: ApplicationMap,
): string {
  const priorSection = priorDraft
    ? [
        "This is a REVISION of a previously elaborated intent. Ground your analysis in what was already",
        "established rather than starting over — do not re-ask about anything the prior draft already resolved.",
        `Prior goal: ${priorDraft.goal}`,
        `Prior requirements: ${priorDraft.requirements.map((claim) => claim.text).join("; ") || "(none)"}`,
        `Prior assumptions: ${priorDraft.assumptions.map((claim) => claim.text).join("; ") || "(none)"}`,
        `The user's new instruction: ${prompt}`,
      ].join("\n")
    : `User request: ${prompt}`;

  return [
    "You are the planner establishing common ground with the user before any code is written or work is multiplied across agents.",
    priorSection,
    `Repository facts (deterministic, not your memory): ${map.summary.summary}`,
    "Distinguish what the user explicitly said (user-explicit) from what you are inferring (planner-inferred) or reading off the repository (repository-derived).",
    "Only raise a clarification question when getting it wrong would materially affect execution, architecture, scope, safety, destructive behavior, public interfaces, acceptance criteria, or cost. Resolve trivial implementation choices yourself as planner-inferred claims instead of asking.",
    "For every material question, always include a 'delegate' option whose resolutionText is your own recommended default, so the user can hand you the decision without specifying the implementation themselves.",
    "Respond with ONLY JSON matching this shape (no prose, no code fences):",
    ELABORATION_SHAPE_HINT,
  ].join("\n\n");
}

function buildTasks(
  orchestrationId: string,
  route: RouteDecision,
  requirementDescriptions: Map<string, string>,
  applicationMapVersion: number,
): OrchestrationTask[] {
  if (route.selectedMode === "direct") return [];
  return route.clusters.map((cluster, index) => ({
    id: randomUUID(),
    orchestrationId,
    title: `Task ${index + 1}: ${cluster.label}`,
    objective:
      cluster.criterionIds.map((id) => requirementDescriptions.get(id)).filter(Boolean).join("; ") ||
      `Implement requirements in "${cluster.label}"`,
    status: "ready",
    dependsOn: [],
    allowedPaths: cluster.directory ? [cluster.directory] : [],
    acceptanceCriterionIds: cluster.criterionIds,
    requiredArtifactIds: [],
    observedArtifactVersions: {},
    applicationMapVersion,
    attemptCount: 0,
  }));
}

function buildDirectPrompt(input: PlanInput | ExecuteInput): string {
  const criteria = input.contract.criteria
    .map((criterion) => `- (${criterion.kind}) ${criterion.description}`)
    .join("\n");
  return [
    `Implement the confirmed request: ${input.contract.intent.goal}`,
    `Acceptance criteria:\n${criteria}`,
    "Make the necessary file changes now.",
  ].join("\n");
}

function buildAmbiguousContractAmendment(input: ExecuteInput, task: OrchestrationTask, reason: string): ContractAmendment {
  return {
    id: randomUUID(),
    orchestrationId: input.orchestration.id,
    baseContractId: input.contract.id,
    proposedIntent: input.contract.intent,
    proposedCriteria: null,
    reason: `Task "${task.title}" discovered a conflict with the confirmed contract: ${reason}`,
    material: true,
    status: "pending",
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
}

function buildDriftAmendment(input: ExecuteInput): ContractAmendment {
  return {
    id: randomUUID(),
    orchestrationId: input.orchestration.id,
    baseContractId: input.contract.id,
    proposedIntent: input.contract.intent,
    proposedCriteria: null,
    reason:
      "The main Agent workspace changed while workers were executing (a user or another process edited it). " +
      "Integration was halted rather than overwriting those changes.",
    material: true,
    status: "pending",
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
}

/**
 * Composes the router, application map, context broker, worker isolation,
 * preflight, bounded worker loop, artifact registry, verification, and
 * integrator into the real `OrchestrationExecutionDriver`. Task 1 controls
 * the lifecycle around every call this makes (confirmation before planning,
 * a confirmed contract before execution); this driver never bypasses that.
 */
export function createEngineDriver(config: EngineConfig): OrchestrationExecutionDriver {
  const cancelled = new Set<string>();

  // Each call from Task 1 passes its own sink instance (scoped to one
  // orchestration); build a fresh RoleExecutorDeps around it rather than
  // holding a single mutable one.
  const withSink = (sink: RoleExecutorDeps["sink"]): RoleExecutorDeps => ({
    runner: config.runner,
    sink,
    modelIds: config.modelIds,
    defaultModelId: config.defaultModelId,
  });

  return {
    async elaborateIntent(input, sink, signal) {
      const deps = withSink(sink);
      const map = await buildApplicationMap(input.orchestrationId, input.workspacePath, 1);
      const prompt = buildElaborationPrompt(input.prompt, input.priorDraft, map);
      const { value } = await callRoleStructured(
        deps,
        {
          agentId: input.agentId,
          orchestrationId: input.orchestrationId,
          taskId: null,
          role: "planner",
          prompt,
          workspacePath: input.workspacePath,
          threadId: null,
          estimatedInputTokens: 1200,
          estimatedOutputTokens: 900,
          signal,
          sandboxMode: "read-only",
        },
        elaborationOutputSchema,
      );
      return { draft: toIntentDraft(input.orchestrationId, value), estimate: toEstimate(value) };
    },

    async plan(input, sink, signal) {
      void sink;
      void signal;
      const map = await buildApplicationMap(input.orchestration.id, input.workspacePath, 1);
      const route = decideRoute(input.contract, map, input.orchestration.requestedMode);
      const descriptions = new Map(input.contract.criteria.map((criterion) => [criterion.id, criterion.description]));
      const tasks = buildTasks(input.orchestration.id, route, descriptions, map.summary.version);
      return { selectedMode: route.selectedMode, routeReason: route.routeReason, tasks, applicationMap: map.summary };
    },

    async execute(input, sink, signal): Promise<ExecutionOutcome> {
      if (cancelled.has(input.orchestration.id)) {
        return { kind: "cancelled", reason: "Cancelled before execution began" };
      }
      const deps = withSink(sink);
      const baseManifest = await buildManifest(input.workspacePath);

      if (input.plan.selectedMode === "direct") {
        try {
          await callRole(deps, {
            agentId: input.orchestration.agentId,
            orchestrationId: input.orchestration.id,
            taskId: null,
            role: "worker",
            prompt: buildDirectPrompt(input),
            workspacePath: input.workspacePath,
            threadId: null,
            estimatedInputTokens: 1000,
            estimatedOutputTokens: 800,
            signal,
            sandboxMode: "workspace-write",
          });
        } catch (error) {
          if (error instanceof BudgetDeniedError) return { kind: "budget-exhausted", reason: error.message };
          return { kind: "failed", reason: describeError(error) };
        }
        const verifications = await runChecks(
          input.orchestration.id,
          null,
          [...config.protectedChecks, ...config.globalChecks],
          input.workspacePath,
          config.checkRunner,
          sink,
        );
        if (!allPassed(verifications)) {
          return { kind: "failed", reason: "Global verification failed after direct execution" };
        }
        return { kind: "completed", finalOutput: "Direct execution completed and verified" };
      }

      const map = await buildApplicationMap(input.orchestration.id, input.workspacePath, input.plan.applicationMap.version);
      const artifactRegistry = createArtifactRegistry(input.orchestration.id, sink);
      const workerResults: WorkerResult[] = [];

      for (const task of input.plan.tasks) {
        if (signal.aborted || cancelled.has(input.orchestration.id)) {
          return { kind: "cancelled", reason: "Cancelled during worker execution" };
        }
        const observedArtifactVersions = Object.fromEntries(
          task.requiredArtifactIds.map((name) => [name, artifactRegistry.latestVersion(name)]),
        );
        const contextPacket = buildContextPacket(
          task.id,
          map,
          input.contract.version,
          task.allowedPaths,
          observedArtifactVersions,
        );

        let result;
        try {
          result = await runWorkerLoop(
            { roleDeps: deps, scratchRoot: config.scratchRoot, checkRunner: config.checkRunner },
            input.orchestration.id,
            input.orchestration.agentId,
            input.contract,
            task,
            contextPacket,
            input.workspacePath,
            input.orchestration.budget,
            signal,
          );
        } catch (error) {
          if (error instanceof BudgetDeniedError) return { kind: "budget-exhausted", reason: error.message };
          throw error;
        }

        await sink.upsertTask({
          ...task,
          status: result.status === "passed" ? "passed" : result.status === "cancelled" ? "cancelled" : "failed",
          attemptCount: result.attempts,
        });

        if (result.status === "cancelled") {
          for (const done of workerResults) {
            await cleanupTaskWorkspace(done.workspace, config.scratchRoot).catch(() => undefined);
          }
          await cleanupTaskWorkspace(result.workspace, config.scratchRoot).catch(() => undefined);
          return { kind: "cancelled", reason: "Cancelled during worker execution" };
        }

        if (result.status === "failed") {
          const packet =
            result.failurePacket ??
            buildFailurePacket(task, input.contract, result.attempts, result.changedFiles, [], "Unknown failure", {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
            });
          const classification = classifyFailure(packet, false);
          for (const done of workerResults) {
            await cleanupTaskWorkspace(done.workspace, config.scratchRoot).catch(() => undefined);
          }
          await cleanupTaskWorkspace(result.workspace, config.scratchRoot).catch(() => undefined);
          if (classification === "ambiguous-contract") {
            return {
              kind: "needs-user",
              amendment: buildAmbiguousContractAmendment(input, task, packet.lastError),
            };
          }
          return {
            kind: "failed",
            reason: `Task "${task.title}" failed after ${result.attempts} attempt(s) [${classification}]: ${packet.lastError}`,
          };
        }

        await artifactRegistry.publish(
          "test-result",
          `${task.title}-result`,
          `Task "${task.title}" passed with ${result.changedFiles.length} changed file(s)`,
          task.id,
        );
        workerResults.push({ task, workspace: result.workspace, changedFiles: result.changedFiles });
      }

      const integration = await integrate(
        {
          scratchRoot: config.scratchRoot,
          checkRunner: config.checkRunner,
          roleDeps: deps,
          protectedChecks: config.protectedChecks,
          globalChecks: config.globalChecks,
        },
        input.orchestration.id,
        input.orchestration.agentId,
        input.contract,
        { mainWorkspacePath: input.workspacePath, baseManifest, workerResults },
        signal,
      );

      for (const result of workerResults) {
        await cleanupTaskWorkspace(result.workspace, config.scratchRoot).catch(() => undefined);
      }

      if (integration.status === "drift") {
        return { kind: "needs-user", amendment: buildDriftAmendment(input) };
      }
      if (integration.status !== "published") {
        return { kind: "failed", reason: `Integration/verification failed (${integration.status})` };
      }
      return { kind: "completed", finalOutput: `Published changes to ${integration.changedFiles.length} file(s)` };
    },

    async cancel(orchestrationId) {
      cancelled.add(orchestrationId);
      return true;
    },
  };
}
