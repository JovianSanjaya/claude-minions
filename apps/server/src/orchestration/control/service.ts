import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import type {
  BudgetPolicy,
  ContractAmendment,
  ContractCriterion,
  ExecutionContract,
  IntentCategory,
  IntentClaim,
  IntentDraft,
  IntentProvenance,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  PlanResult,
  RequestedExecutionMode,
  TokenUsage,
} from "../contracts.js";
import {
  DEFAULT_BUDGET_POLICY,
  budgetPolicySchema,
  commitModelUsage,
  createEmptyUsageLedger,
  estimateExceedsBudget,
  reserveModelCall,
  type BudgetPolicyOverride,
  type PricingTable,
} from "./budget-ledger.js";
import {
  DEFAULT_CLARIFICATION_POLICY,
  applyClarificationPolicy,
  type ClarificationPolicyConfig,
} from "./clarification-policy.js";
import { buildOrchestrationReadModel } from "./read-model.js";
import { redactDeep } from "./redaction.js";
import { assertLegalTransition, TERMINAL_STATUSES } from "./state-machine.js";
import type { OrchestrationDb, OrchestrationStore } from "./store.js";

const now = () => new Date().toISOString();

export interface AgentSnapshot {
  id: string;
  status: string;
  workspacePath: string;
}

/**
 * Authoritative Agent lookup, injected rather than imported, so this module
 * stays testable without the baseline AgentService and so Final Assembly can
 * wire the real one without this file needing to know its shape.
 */
export interface AgentAccessPort {
  getAgent(agentId: string): AgentSnapshot | null;
}

export const provenanceSchema = z.enum([
  "user-explicit",
  "planner-inferred",
  "repository-derived",
  "user-delegated",
]);

export const contractCriterionSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: z.string().trim().min(1).max(2000),
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
  provenance: provenanceSchema.default("user-explicit"),
  sourceClaimId: z.string().nullable().default(null),
});

export const criteriaOverrideSchema = z.array(contractCriterionSchema).min(1).max(100);

export interface CreateOrchestrationInput {
  agentId: string;
  prompt: string;
  requestedMode?: RequestedExecutionMode | undefined;
  budget?: BudgetPolicyOverride | undefined;
}

export interface ConfirmIntentInput {
  orchestrationId: string;
  criteria?: z.infer<typeof criteriaOverrideSchema> | undefined;
}

export interface ProposeAmendmentInput {
  orchestrationId: string;
  reason: string;
  goal?: string | undefined;
  requirements?: string[] | undefined;
  assumptions?: string[] | undefined;
  nonGoals?: string[] | undefined;
  architectureDecisions?: string[] | undefined;
  manualExpectations?: string[] | undefined;
  criteria?: z.infer<typeof criteriaOverrideSchema> | undefined;
}

export interface AnswerClarificationInput {
  orchestrationId: string;
  questionId: string;
  optionId?: string | undefined;
  freeText?: string | undefined;
}

const CLAIM_CATEGORIES: IntentCategory[] = [
  "requirements",
  "assumptions",
  "nonGoals",
  "architectureDecisions",
  "manualExpectations",
];

function ensureClaimIds(claims: IntentClaim[]): IntentClaim[] {
  return claims.map((claim) => ({ ...claim, id: claim.id || randomUUID() }));
}

/** Appends a claim, dropping whatever prior claim it supersedes (immutable-per-revision: this never mutates history, only the draft revision being built). */
function appendClaim(claims: IntentClaim[], claim: IntentClaim): IntentClaim[] {
  return [...claims.filter((existing) => existing.id !== claim.supersedes), claim];
}

function wrapExplicitClaims(values: string[] | undefined): IntentClaim[] {
  return (values ?? []).map((text) => ({
    id: randomUUID(),
    text,
    provenance: "user-explicit",
    materiality: "trivial",
    rationale: null,
    supersedes: null,
  }));
}

function emptyDraft(orchestrationId: string): IntentDraft {
  return {
    id: randomUUID(),
    orchestrationId,
    revision: 0,
    goal: "",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    manualExpectations: [],
    openQuestions: [],
    createdAt: now(),
  };
}

function deriveCriteria(draft: IntentDraft): ContractCriterion[] {
  const criteria: ContractCriterion[] = [];
  const push = (
    claims: IntentClaim[],
    kind: ContractCriterion["kind"],
    verification: ContractCriterion["verification"],
    describe: (claim: IntentClaim) => string,
  ) => {
    for (const claim of claims) {
      criteria.push({
        id: randomUUID(),
        kind,
        description: describe(claim),
        verification,
        provenance: claim.provenance,
        sourceClaimId: claim.id,
      });
    }
  };
  push(draft.requirements, "functional", "visible-test", (claim) => claim.text);
  push(draft.architectureDecisions, "architectural", "static-check", (claim) => claim.text);
  push(draft.nonGoals, "scope", "static-check", (claim) => `Out of scope: ${claim.text}`);
  push(draft.manualExpectations, "manual", "manual", (claim) => claim.text);
  criteria.push({
    id: randomUUID(),
    kind: "runtime",
    description:
      "Existing Agent CRUD, lifecycle, and direct Playground behavior must continue to pass",
    verification: "protected-test",
    provenance: "repository-derived",
    sourceClaimId: null,
  });
  return criteria;
}

function resolveCriteria(
  draft: IntentDraft,
  override: z.infer<typeof criteriaOverrideSchema> | undefined,
): ContractCriterion[] {
  if (!override) return deriveCriteria(draft);
  return override.map((criterion) => ({ ...criterion, id: criterion.id ?? randomUUID() }));
}

function buildEvent(partial: Omit<OrchestrationEvent, "id" | "createdAt">): OrchestrationEvent {
  return { ...partial, id: randomUUID(), createdAt: now() };
}

interface PendingReservation {
  orchestrationId: string;
  role: ModelCallReservation["role"];
  modelId: string;
}

export class OrchestrationControlService {
  private readonly pendingReservations = new Map<string, PendingReservation>();
  private readonly pendingBackgroundWork = new Map<string, Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();
  /** The plan reviewed at "ready", held only in memory between planning and `/start` — see runPlanning/runExecution. */
  private readonly planCache = new Map<string, PlanResult>();

  constructor(
    private readonly store: OrchestrationStore,
    private readonly agents: AgentAccessPort,
    private readonly driver: OrchestrationExecutionDriver,
    private readonly pricing?: PricingTable,
    private readonly clarificationPolicy: ClarificationPolicyConfig = DEFAULT_CLARIFICATION_POLICY,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.mutate((db) => {
      for (const orchestration of db.orchestrations) {
        if (!TERMINAL_STATUSES.has(orchestration.status)) {
          orchestration.status = "cancelled";
          orchestration.error = "Server restarted while this orchestration was active";
          orchestration.updatedAt = now();
          orchestration.completedAt = now();
          db.events.push(
            buildEvent({
              orchestrationId: orchestration.id,
              taskId: null,
              executionId: null,
              type: "restart-reconciled",
              actorRole: "control-plane",
              modelId: null,
              summary: "Marked cancelled after a server restart interrupted this orchestration",
              metadata: {},
            }),
          );
        }
      }
    });
  }

  /**
   * Resolves once the most recently scheduled background work (intent
   * elaboration, or plan+execute after `/start`) for this orchestration has
   * settled. Background work runs fire-and-forget so HTTP handlers can
   * return immediately; this is a **test-only** hook for deterministic
   * assertions, not part of the product surface.
   */
  async waitForPendingWork(orchestrationId: string): Promise<void> {
    await (this.pendingBackgroundWork.get(orchestrationId) ?? Promise.resolve());
  }

  private buildSink(orchestrationId: string): OrchestrationSink {
    return {
      reserveModelCall: async (input: ModelCallReservation) => {
        const db = this.store.snapshot();
        const orchestration = db.orchestrations.find((item) => item.id === orchestrationId);
        if (!orchestration) {
          return { allowed: false, reason: "Orchestration not found" };
        }
        const decision = reserveModelCall(
          orchestration.usage,
          orchestration.budget,
          input,
          this.pricing,
        );
        if (decision.allowed) {
          this.pendingReservations.set(decision.reservationId, {
            orchestrationId,
            role: input.role,
            modelId: input.modelId,
          });
        } else {
          await this.store.mutate((mutableDb) => {
            mutableDb.events.push(
              buildEvent({
                orchestrationId,
                taskId: input.taskId,
                executionId: input.executionId,
                type: "budget-denied",
                actorRole: input.role,
                modelId: input.modelId,
                summary: redactDeep(decision.reason),
                metadata: {
                  estimatedInputTokens: input.estimatedInputTokens,
                  estimatedOutputTokens: input.estimatedOutputTokens,
                },
              }),
            );
          });
        }
        return decision;
      },
      commitModelUsage: async (reservationId: string, actual: TokenUsage) => {
        const pending = this.pendingReservations.get(reservationId);
        if (!pending) return;
        this.pendingReservations.delete(reservationId);
        await this.store.mutate((db) => {
          const orchestration = db.orchestrations.find(
            (item) => item.id === pending.orchestrationId,
          );
          if (!orchestration) return;
          orchestration.usage = commitModelUsage(
            orchestration.usage,
            pending.role,
            pending.modelId,
            actual,
            this.pricing,
          );
          orchestration.updatedAt = now();
        });
      },
      recordEvent: async (event) => {
        await this.store.mutate((db) => {
          db.events.push(redactDeep(buildEvent(event)));
        });
      },
      upsertTask: async (task) => {
        await this.store.mutate((db) => {
          const index = db.tasks.findIndex((item) => item.id === task.id);
          const safe = redactDeep(task);
          if (index >= 0) db.tasks[index] = safe;
          else db.tasks.push(safe);
        });
      },
      recordApplicationMap: async (map) => {
        await this.store.mutate((db) => {
          db.applicationMaps.push(redactDeep(map));
        });
      },
      recordContextPacket: async (packet) => {
        await this.store.mutate((db) => {
          db.contextPackets.push(redactDeep(packet));
        });
      },
      recordAttempt: async (attempt) => {
        await this.store.mutate((db) => {
          const index = db.attempts.findIndex((item) => item.id === attempt.id);
          const safe = redactDeep(attempt);
          if (index >= 0) db.attempts[index] = safe;
          else db.attempts.push(safe);
        });
      },
      publishArtifact: async (artifact) => {
        await this.store.mutate((db) => {
          db.artifacts.push(redactDeep(artifact));
        });
      },
      recordVerification: async (record) => {
        await this.store.mutate((db) => {
          db.verifications.push(redactDeep(record));
        });
      },
    };
  }

  private getOrchestrationOrThrow(
    db: { orchestrations: Orchestration[] },
    id: string,
  ): Orchestration {
    const orchestration = db.orchestrations.find((item) => item.id === id);
    if (!orchestration) {
      throw new HttpError(404, "Orchestration not found");
    }
    return orchestration;
  }

  listOrchestrations(agentId: string): Orchestration[] {
    return this.store
      .snapshot()
      .orchestrations.filter((item) => item.agentId === agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getOrchestration(orchestrationId: string): Orchestration {
    return this.getOrchestrationOrThrow(this.store.snapshot(), orchestrationId);
  }

  getReadModel(orchestrationId: string) {
    return buildOrchestrationReadModel(this.store.snapshot(), orchestrationId);
  }

  async createOrchestration(input: CreateOrchestrationInput): Promise<Orchestration> {
    const agent = this.agents.getAgent(input.agentId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before creating an orchestration");
    }
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new HttpError(400, "prompt must not be empty");
    }
    let budget: BudgetPolicy;
    try {
      budget = budgetPolicySchema.parse({ ...DEFAULT_BUDGET_POLICY, ...input.budget });
    } catch (error) {
      throw new HttpError(400, `Invalid budget policy: ${(error as Error).message}`);
    }

    const timestamp = now();
    const orchestration: Orchestration = {
      id: randomUUID(),
      agentId: input.agentId,
      prompt: redactDeep(prompt),
      requestedMode: input.requestedMode ?? "auto",
      selectedMode: null,
      status: "drafting-intent",
      currentIntentDraftId: null,
      activeContractId: null,
      estimate: null,
      budget,
      usage: createEmptyUsageLedger(),
      finalOutput: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };

    await this.store.mutate((db) => {
      const hasActive = db.orchestrations.some(
        (item) => item.agentId === input.agentId && !TERMINAL_STATUSES.has(item.status),
      );
      if (hasActive) {
        throw new HttpError(409, "An orchestration is already active for this Agent");
      }
      db.orchestrations.push(orchestration);
      db.events.push(
        buildEvent({
          orchestrationId: orchestration.id,
          taskId: null,
          executionId: null,
          type: "orchestration-created",
          actorRole: "user",
          modelId: null,
          summary: "Orchestration created",
          metadata: { requestedMode: orchestration.requestedMode },
        }),
      );
    });

    this.scheduleElaboration(orchestration.id, agent.workspacePath, prompt, null);
    return orchestration;
  }

  async reviseIntent(orchestrationId: string, note: string): Promise<Orchestration> {
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      throw new HttpError(400, "Revision note must not be empty");
    }
    const context = await this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(orchestration.status, "drafting-intent");
      const priorDraft =
        db.intentDrafts.find((item) => item.id === orchestration.currentIntentDraftId) ?? null;
      orchestration.status = "drafting-intent";
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "intent-revision-requested",
          actorRole: "user",
          modelId: null,
          summary: redactDeep(trimmedNote),
          metadata: {},
        }),
      );
      return { agentId: orchestration.agentId, priorDraft };
    });
    const agent = this.agents.getAgent(context.agentId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    this.scheduleElaboration(orchestrationId, agent.workspacePath, trimmedNote, context.priorDraft);
    return this.getOrchestration(orchestrationId);
  }

  private scheduleElaboration(
    orchestrationId: string,
    workspacePath: string,
    prompt: string,
    priorDraft: IntentDraft | null,
  ): void {
    const controller = new AbortController();
    this.activeControllers.set(orchestrationId, controller);
    const promise = this.runElaboration(orchestrationId, workspacePath, prompt, priorDraft, controller.signal)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.mutate((db) => {
          const orchestration = db.orchestrations.find((item) => item.id === orchestrationId);
          if (!orchestration) return;
          orchestration.error = redactDeep(message);
          orchestration.updatedAt = now();
        });
      })
      .finally(() => {
        if (this.activeControllers.get(orchestrationId) === controller) {
          this.activeControllers.delete(orchestrationId);
        }
      });
    this.pendingBackgroundWork.set(orchestrationId, promise);
    void promise;
  }

  private async runElaboration(
    orchestrationId: string,
    workspacePath: string,
    prompt: string,
    priorDraft: IntentDraft | null,
    signal: AbortSignal,
  ): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId);
    const sink = this.buildSink(orchestrationId);
    const { draft, estimate } = await this.driver.elaborateIntent(
      {
        orchestrationId,
        agentId: orchestration.agentId,
        prompt,
        requestedMode: orchestration.requestedMode,
        budget: orchestration.budget,
        workspacePath,
        priorDraft,
      },
      sink,
      signal,
    );

    const { open, autoResolved } = applyClarificationPolicy(draft.openQuestions, this.clarificationPolicy);

    await this.store.mutate((db) => {
      const item = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(item.status, "awaiting-confirmation");
      const revisionNumber = db.intentDrafts.filter(
        (existing) => existing.orchestrationId === orchestrationId,
      ).length;

      const base: IntentDraft = {
        ...emptyDraft(orchestrationId),
        ...draft,
        id: draft.id || randomUUID(),
        orchestrationId,
        revision: revisionNumber,
        requirements: ensureClaimIds(draft.requirements),
        assumptions: ensureClaimIds(draft.assumptions),
        nonGoals: ensureClaimIds(draft.nonGoals),
        architectureDecisions: ensureClaimIds(draft.architectureDecisions),
        manualExpectations: ensureClaimIds(draft.manualExpectations),
        openQuestions: open,
        createdAt: now(),
      };
      for (const resolved of autoResolved) {
        base[resolved.question.category] = appendClaim(
          base[resolved.question.category],
          resolved.claim,
        );
      }
      const safeDraft: IntentDraft = redactDeep(base);

      db.intentDrafts.push(safeDraft);
      item.currentIntentDraftId = safeDraft.id;
      item.estimate = redactDeep(estimate);
      item.status = "awaiting-confirmation";
      item.error = null;
      item.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "intent-elaborated",
          actorRole: "planner",
          modelId: null,
          summary: `Draft revision ${safeDraft.revision}: ${open.length} open question(s), ${autoResolved.length} auto-resolved`,
          metadata: { revision: safeDraft.revision, openQuestions: open.length, autoResolved: autoResolved.length },
        }),
      );
    });
  }

  async answerClarification(input: AnswerClarificationInput): Promise<Orchestration> {
    const freeText = input.freeText?.trim();
    if (!input.optionId && !freeText) {
      throw new HttpError(400, "Provide either optionId or freeText to answer a clarification question");
    }
    return this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, input.orchestrationId);
      if (orchestration.status !== "awaiting-confirmation") {
        throw new HttpError(
          409,
          `Cannot answer a clarification question while the orchestration is "${orchestration.status}"`,
        );
      }
      const draft = db.intentDrafts.find((item) => item.id === orchestration.currentIntentDraftId);
      if (!draft) {
        throw new HttpError(422, "No intent draft is available");
      }
      const question = draft.openQuestions.find((item) => item.id === input.questionId);
      if (!question) {
        throw new HttpError(404, "Clarification question not found or already resolved");
      }

      let resolutionText: string;
      let provenance: IntentProvenance;
      if (input.optionId) {
        const option = question.options.find((item) => item.id === input.optionId);
        if (!option) {
          throw new HttpError(404, "Clarification option not found");
        }
        resolutionText = option.resolutionText;
        provenance = option.delegate ? "user-delegated" : "user-explicit";
      } else {
        resolutionText = freeText as string;
        provenance = "user-explicit";
      }

      const claim: IntentClaim = {
        id: randomUUID(),
        text: resolutionText,
        provenance,
        materiality: "trivial",
        rationale:
          provenance === "user-delegated"
            ? "User delegated this decision to the AI's recommendation."
            : null,
        supersedes: question.relatedClaimIds[0] ?? null,
      };

      const revisionNumber = db.intentDrafts.filter(
        (item) => item.orchestrationId === input.orchestrationId,
      ).length;
      const nextDraft: IntentDraft = {
        ...draft,
        id: randomUUID(),
        revision: revisionNumber,
        openQuestions: draft.openQuestions.filter((item) => item.id !== question.id),
        createdAt: now(),
      };
      nextDraft[question.category] = appendClaim(draft[question.category], claim);
      const safeDraft = redactDeep(nextDraft);

      db.intentDrafts.push(safeDraft);
      orchestration.currentIntentDraftId = safeDraft.id;
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId: input.orchestrationId,
          taskId: null,
          executionId: null,
          type: "clarification-answered",
          actorRole: "user",
          modelId: null,
          summary: `Answered "${question.prompt}" (${provenance})`,
          metadata: { questionId: question.id, provenance },
        }),
      );
      return orchestration;
    });
  }

  async confirmIntent(input: ConfirmIntentInput): Promise<ExecutionContract> {
    return this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, input.orchestrationId);
      assertLegalTransition(orchestration.status, "planning");
      const draft = db.intentDrafts.find((item) => item.id === orchestration.currentIntentDraftId);
      if (!draft) {
        throw new HttpError(422, "No intent draft is available to confirm");
      }
      if (draft.openQuestions.length > 0) {
        throw new HttpError(
          422,
          "Unresolved material questions must be addressed before confirmation",
        );
      }
      if (orchestration.estimate) {
        const exceeds = estimateExceedsBudget(orchestration.estimate, orchestration.budget);
        if (exceeds) {
          throw new HttpError(422, exceeds);
        }
      }
      const criteria = resolveCriteria(draft, input.criteria);
      const previousVersion = db.contracts.filter(
        (item) => item.orchestrationId === input.orchestrationId,
      ).length;
      const contract: ExecutionContract = {
        id: randomUUID(),
        orchestrationId: input.orchestrationId,
        version: previousVersion + 1,
        intent: draft,
        criteria,
        confirmedBy: "user",
        confirmedAt: now(),
        supersedesContractId: orchestration.activeContractId,
      };
      db.contracts.push(contract);
      orchestration.activeContractId = contract.id;
      orchestration.status = "planning";
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId: input.orchestrationId,
          taskId: null,
          executionId: null,
          type: "intent-confirmed",
          actorRole: "user",
          modelId: null,
          summary: `Contract v${contract.version} confirmed with ${criteria.length} criteria`,
          metadata: { contractVersion: contract.version, criteriaCount: criteria.length },
        }),
      );
      return { contract, agentId: orchestration.agentId };
    }).then(({ contract, agentId }) => {
      this.schedulePlanningFor(input.orchestrationId, agentId);
      return contract;
    });
  }

  /** Looks up the Agent's workspace and kicks off background planning; used after any confirm (initial or amendment). */
  private schedulePlanningFor(orchestrationId: string, agentId: string): void {
    const agent = this.agents.getAgent(agentId);
    if (!agent) return; // defensive: agent existed at confirm time; nothing sensible to do if it vanished mid-flight
    this.schedulePlanning(orchestrationId, agent.workspacePath);
  }

  async proposeAmendment(input: ProposeAmendmentInput): Promise<ContractAmendment> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new HttpError(400, "An amendment requires a reason");
    }
    return this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, input.orchestrationId);
      if (!orchestration.activeContractId) {
        throw new HttpError(422, "No confirmed contract exists to amend");
      }
      assertLegalTransition(orchestration.status, "needs-user");
      const baseDraft = db.intentDrafts.find(
        (item) => item.id === orchestration.currentIntentDraftId,
      );
      if (!baseDraft) {
        throw new HttpError(422, "No intent draft is available to amend");
      }
      const revisionNumber = db.intentDrafts.filter(
        (item) => item.orchestrationId === input.orchestrationId,
      ).length;
      const proposedIntent: IntentDraft = redactDeep({
        id: randomUUID(),
        orchestrationId: input.orchestrationId,
        revision: revisionNumber,
        goal: input.goal ?? baseDraft.goal,
        requirements: input.requirements ? wrapExplicitClaims(input.requirements) : baseDraft.requirements,
        assumptions: input.assumptions ? wrapExplicitClaims(input.assumptions) : baseDraft.assumptions,
        nonGoals: input.nonGoals ? wrapExplicitClaims(input.nonGoals) : baseDraft.nonGoals,
        architectureDecisions: input.architectureDecisions
          ? wrapExplicitClaims(input.architectureDecisions)
          : baseDraft.architectureDecisions,
        manualExpectations: input.manualExpectations
          ? wrapExplicitClaims(input.manualExpectations)
          : baseDraft.manualExpectations,
        openQuestions: [],
        createdAt: now(),
      });
      const amendment: ContractAmendment = {
        id: randomUUID(),
        orchestrationId: input.orchestrationId,
        baseContractId: orchestration.activeContractId,
        proposedIntent,
        proposedCriteria: input.criteria
          ? input.criteria.map((criterion) => ({ ...criterion, id: criterion.id ?? randomUUID() }))
          : null,
        reason: redactDeep(reason),
        material: true,
        status: "pending",
        createdAt: now(),
        decidedAt: null,
      };
      db.amendments.push(amendment);
      orchestration.status = "needs-user";
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId: input.orchestrationId,
          taskId: null,
          executionId: null,
          type: "amendment-proposed",
          actorRole: "user",
          modelId: null,
          summary: redactDeep(reason),
          metadata: { amendmentId: amendment.id },
        }),
      );
      return amendment;
    });
  }

  /**
   * Persists a material amendment produced by the execution driver's
   * `execute()` outcome (`{kind: "needs-user", amendment}`) — the
   * "common-ground repair during execution" path. Status/decision fields are
   * always overridden here rather than trusted from the driver: this
   * control plane, not the driver, decides an amendment's lifecycle state.
   */
  private recordDriverAmendment(
    db: OrchestrationDb,
    orchestration: Orchestration,
    amendment: ContractAmendment,
  ): void {
    const safe: ContractAmendment = redactDeep({
      ...amendment,
      orchestrationId: orchestration.id,
      baseContractId: orchestration.activeContractId ?? amendment.baseContractId,
      status: "pending",
      decidedAt: null,
      createdAt: amendment.createdAt || now(),
    });
    db.amendments.push(safe);
    db.events.push(
      buildEvent({
        orchestrationId: orchestration.id,
        taskId: null,
        executionId: null,
        type: "amendment-proposed-by-execution",
        actorRole: "planner",
        modelId: null,
        summary: redactDeep(amendment.reason),
        metadata: { amendmentId: safe.id },
      }),
    );
  }

  async confirmAmendment(orchestrationId: string, amendmentId: string): Promise<ExecutionContract> {
    return this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(orchestration.status, "planning");
      const amendment = db.amendments.find(
        (item) => item.id === amendmentId && item.orchestrationId === orchestrationId,
      );
      if (!amendment) {
        throw new HttpError(404, "Amendment not found");
      }
      if (amendment.status !== "pending") {
        throw new HttpError(409, `Amendment already ${amendment.status}`);
      }
      db.intentDrafts.push(amendment.proposedIntent);
      const criteria = amendment.proposedCriteria ?? deriveCriteria(amendment.proposedIntent);
      const previousVersion = db.contracts.filter(
        (item) => item.orchestrationId === orchestrationId,
      ).length;
      const contract: ExecutionContract = {
        id: randomUUID(),
        orchestrationId,
        version: previousVersion + 1,
        intent: amendment.proposedIntent,
        criteria,
        confirmedBy: "user",
        confirmedAt: now(),
        supersedesContractId: orchestration.activeContractId,
      };
      db.contracts.push(contract);
      amendment.status = "confirmed";
      amendment.decidedAt = now();
      orchestration.activeContractId = contract.id;
      orchestration.currentIntentDraftId = amendment.proposedIntent.id;
      orchestration.status = "planning";
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "amendment-confirmed",
          actorRole: "user",
          modelId: null,
          summary: `Contract v${contract.version} confirmed via amendment`,
          metadata: { amendmentId, contractVersion: contract.version },
        }),
      );
      return { contract, agentId: orchestration.agentId };
    }).then(({ contract, agentId }) => {
      this.schedulePlanningFor(orchestrationId, agentId);
      return contract;
    });
  }

  async rejectAmendment(orchestrationId: string, amendmentId: string): Promise<ContractAmendment> {
    return this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(orchestration.status, "planning");
      const amendment = db.amendments.find(
        (item) => item.id === amendmentId && item.orchestrationId === orchestrationId,
      );
      if (!amendment) {
        throw new HttpError(404, "Amendment not found");
      }
      if (amendment.status !== "pending") {
        throw new HttpError(409, `Amendment already ${amendment.status}`);
      }
      amendment.status = "rejected";
      amendment.decidedAt = now();
      orchestration.status = "planning";
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "amendment-rejected",
          actorRole: "user",
          modelId: null,
          summary: "Amendment rejected; active contract unchanged",
          metadata: { amendmentId },
        }),
      );
      return amendment;
    });
  }

  /**
   * Runs `driver.plan()` in the background right after confirmation
   * (initial or via amendment) so the route/task breakdown reaches
   * `ready` and can be reviewed *before* the user commits to starting
   * execution — the frozen table's `planning -> ready` step, kept
   * genuinely reviewable rather than folded into `/start`.
   */
  private schedulePlanning(orchestrationId: string, workspacePath: string): void {
    this.runBackgroundTransition(orchestrationId, (signal) => this.runPlanning(orchestrationId, workspacePath, signal));
  }

  private async runPlanning(orchestrationId: string, workspacePath: string, signal: AbortSignal): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId);
    const db0 = this.store.snapshot();
    const contract = db0.contracts.find((item) => item.id === orchestration.activeContractId);
    if (!contract) {
      throw new HttpError(422, "No confirmed contract exists to plan from");
    }
    const sink = this.buildSink(orchestrationId);
    const plan = await this.driver.plan({ orchestration, contract, workspacePath }, sink, signal);
    this.planCache.set(orchestrationId, plan);

    await this.store.mutate((db) => {
      const item = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(item.status, "ready");
      item.status = "ready";
      item.selectedMode = plan.selectedMode;
      item.updatedAt = now();
      db.applicationMaps.push(redactDeep(plan.applicationMap));
      for (const task of plan.tasks) {
        const index = db.tasks.findIndex((existing) => existing.id === task.id);
        const safe = redactDeep(task);
        if (index >= 0) db.tasks[index] = safe;
        else db.tasks.push(safe);
      }
      db.events.push(
        buildEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "planned",
          actorRole: "planner",
          modelId: null,
          summary: `Route: ${plan.selectedMode} — ${plan.routeReason}`,
          metadata: { taskCount: plan.tasks.length, selectedMode: plan.selectedMode },
        }),
      );
    });
  }

  /**
   * Starts execution of an already-reviewed plan. Requires `status ===
   * "ready"` — only reached once `runPlanning` above has actually
   * completed — so the browser can show the route/task breakdown and an
   * explicit Start action rather than execution beginning the instant the
   * screen is opened.
   */
  async startOrchestration(orchestrationId: string): Promise<Orchestration> {
    const orchestration = this.getOrchestration(orchestrationId);
    if (orchestration.status !== "ready") {
      throw new HttpError(
        409,
        `Cannot start execution while the orchestration is "${orchestration.status}"`,
      );
    }
    if (!orchestration.activeContractId || !this.planCache.has(orchestrationId)) {
      throw new HttpError(422, "No reviewed plan is available to start execution from");
    }
    const agent = this.agents.getAgent(orchestration.agentId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    this.runBackgroundTransition(orchestrationId, (signal) =>
      this.runExecution(orchestrationId, agent.workspacePath, signal),
    );
    return orchestration;
  }

  /** Shared scheduling for any background step (planning or execution) that transitions status and can legally fail. */
  private runBackgroundTransition(orchestrationId: string, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.activeControllers.set(orchestrationId, controller);
    const promise = task(controller.signal)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.mutate((db) => {
          const orchestration = db.orchestrations.find((item) => item.id === orchestrationId);
          if (!orchestration || TERMINAL_STATUSES.has(orchestration.status)) return;
          if (isLegalTransitionSafe(orchestration.status, "failed")) {
            orchestration.status = "failed";
            orchestration.completedAt = now();
          }
          orchestration.error = redactDeep(message);
          orchestration.updatedAt = now();
        });
      })
      .finally(() => {
        if (this.activeControllers.get(orchestrationId) === controller) {
          this.activeControllers.delete(orchestrationId);
        }
      });
    this.pendingBackgroundWork.set(orchestrationId, promise);
    void promise;
  }

  private async runExecution(orchestrationId: string, workspacePath: string, signal: AbortSignal): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId);
    const db0 = this.store.snapshot();
    const contract = db0.contracts.find((item) => item.id === orchestration.activeContractId);
    if (!contract) {
      throw new HttpError(422, "No confirmed contract exists to start execution from");
    }
    const plan = this.planCache.get(orchestrationId);
    if (!plan) {
      throw new HttpError(422, "No reviewed plan is available to start execution from");
    }
    const sink = this.buildSink(orchestrationId);

    await this.store.mutate((db) => {
      const item = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(item.status, "running");
      item.status = "running";
      item.updatedAt = now();
    });

    const runningOrchestration = this.getOrchestration(orchestrationId);
    const outcome = await this.driver.execute(
      { orchestration: runningOrchestration, contract, workspacePath, plan },
      sink,
      signal,
    ).finally(() => {
      this.planCache.delete(orchestrationId);
    });

    await this.store.mutate((db) => {
      const item = this.getOrchestrationOrThrow(db, orchestrationId);
      if (TERMINAL_STATUSES.has(item.status)) {
        // Cancelled (or otherwise finalized) while execute() was in flight; never clobber it.
        return;
      }
      switch (outcome.kind) {
        case "completed": {
          assertLegalTransition(item.status, "integrating");
          item.status = "integrating";
          assertLegalTransition(item.status, "verifying");
          item.status = "verifying";
          assertLegalTransition(item.status, "completed");
          item.status = "completed";
          item.finalOutput = redactDeep(outcome.finalOutput);
          item.completedAt = now();
          db.events.push(
            buildEvent({
              orchestrationId,
              taskId: null,
              executionId: null,
              type: "execution-completed",
              actorRole: "integrator",
              modelId: null,
              summary: "Execution completed and published",
              metadata: {},
            }),
          );
          break;
        }
        case "needs-user": {
          assertLegalTransition(item.status, "needs-user");
          item.status = "needs-user";
          this.recordDriverAmendment(db, item, outcome.amendment);
          break;
        }
        case "budget-exhausted": {
          assertLegalTransition(item.status, "budget-exhausted");
          item.status = "budget-exhausted";
          item.error = redactDeep(outcome.reason);
          item.completedAt = now();
          break;
        }
        case "cancelled": {
          assertLegalTransition(item.status, "cancelled");
          item.status = "cancelled";
          item.error = redactDeep(outcome.reason);
          item.completedAt = now();
          break;
        }
        case "failed": {
          assertLegalTransition(item.status, "failed");
          item.status = "failed";
          item.error = redactDeep(outcome.reason);
          item.completedAt = now();
          break;
        }
      }
      item.updatedAt = now();
    });
  }

  /**
   * Cancellation is authoritative and immediate: the orchestration is marked
   * `cancelled` as soon as this resolves, without waiting for the
   * background driver call to actually unwind (which could hang if a driver
   * ignores its abort signal). The background task's own completion handler
   * checks for an already-terminal status before writing an outcome, so it
   * can never clobber this decision once made.
   */
  async cancelOrchestration(orchestrationId: string): Promise<Orchestration> {
    const controller = this.activeControllers.get(orchestrationId);
    controller?.abort();
    try {
      await this.driver.cancel(orchestrationId);
    } catch {
      // best-effort: a driver.cancel failure must not block marking cancelled
    }
    return this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, orchestrationId);
      if (TERMINAL_STATUSES.has(orchestration.status)) {
        return orchestration;
      }
      orchestration.status = "cancelled";
      orchestration.error = "Cancelled by user request";
      orchestration.completedAt = now();
      orchestration.updatedAt = now();
      db.events.push(
        buildEvent({
          orchestrationId,
          taskId: null,
          executionId: null,
          type: "cancelled",
          actorRole: "user",
          modelId: null,
          summary: "Orchestration cancelled by user request",
          metadata: {},
        }),
      );
      return orchestration;
    });
  }
}

function isLegalTransitionSafe(
  from: Orchestration["status"],
  to: Orchestration["status"],
): boolean {
  try {
    assertLegalTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cross-task adapter from spec section 6.1: lets direct Playground execution
 * (owned by Task 2's AgentService) and orchestration cancellation (owned by
 * this control plane) avoid racing on the same Agent workspace. Wraps the
 * service (not the raw store) so `cancelForAgent` performs real
 * cancellation — abort signal, `driver.cancel`, terminal status — rather
 * than a status-only stub.
 */
export interface OrchestrationCoordinator {
  assertAgentAvailableForDirect(agentId: string): void;
  hasActiveOrchestration(agentId: string): boolean;
  cancelForAgent(agentId: string): Promise<void>;
}

export function createOrchestrationCoordinator(
  service: OrchestrationControlService,
): OrchestrationCoordinator {
  const hasActive = (agentId: string): boolean =>
    service.listOrchestrations(agentId).some((item) => !TERMINAL_STATUSES.has(item.status));

  return {
    assertAgentAvailableForDirect(agentId: string): void {
      if (hasActive(agentId)) {
        throw new HttpError(
          409,
          "An orchestration is active for this Agent; direct execution is blocked until it finishes or is cancelled",
        );
      }
    },
    hasActiveOrchestration: hasActive,
    async cancelForAgent(agentId: string): Promise<void> {
      const active = service
        .listOrchestrations(agentId)
        .filter((item) => !TERMINAL_STATUSES.has(item.status));
      await Promise.all(active.map((item) => service.cancelOrchestration(item.id)));
    },
  };
}
