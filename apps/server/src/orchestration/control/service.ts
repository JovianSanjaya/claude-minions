import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import type {
  BudgetPolicy,
  ContractAmendment,
  ContractCriterion,
  ExecutionContract,
  IntentDraft,
  ModelCallReservation,
  Orchestration,
  OrchestrationExecutionDriver,
  OrchestrationSink,
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
import { buildOrchestrationReadModel } from "./read-model.js";
import { redactDeep } from "./redaction.js";
import { assertLegalTransition, TERMINAL_STATUSES } from "./state-machine.js";
import type { OrchestrationStore } from "./store.js";

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

export const contractCriterionSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: z.string().trim().min(1).max(2000),
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
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
  materialQuestions?: string[] | undefined;
  manualExpectations?: string[] | undefined;
  criteria?: z.infer<typeof criteriaOverrideSchema> | undefined;
}

function deriveCriteria(draft: IntentDraft): ContractCriterion[] {
  const criteria: ContractCriterion[] = [];
  for (const requirement of draft.requirements) {
    criteria.push({
      id: randomUUID(),
      kind: "functional",
      description: requirement,
      verification: "visible-test",
    });
  }
  for (const decision of draft.architectureDecisions) {
    criteria.push({
      id: randomUUID(),
      kind: "architectural",
      description: decision,
      verification: "static-check",
    });
  }
  for (const nonGoal of draft.nonGoals) {
    criteria.push({
      id: randomUUID(),
      kind: "scope",
      description: `Out of scope: ${nonGoal}`,
      verification: "static-check",
    });
  }
  for (const expectation of draft.manualExpectations) {
    criteria.push({
      id: randomUUID(),
      kind: "manual",
      description: expectation,
      verification: "manual",
    });
  }
  criteria.push({
    id: randomUUID(),
    kind: "runtime",
    description:
      "Existing Agent CRUD, lifecycle, and direct Playground behavior must continue to pass",
    verification: "protected-test",
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
    materialQuestions: [],
    manualExpectations: [],
    createdAt: now(),
  };
}

interface PendingReservation {
  orchestrationId: string;
  role: ModelCallReservation["role"];
  modelId: string;
}

export class OrchestrationControlService {
  private readonly pendingReservations = new Map<string, PendingReservation>();
  private readonly pendingElaborations = new Map<string, Promise<void>>();

  constructor(
    private readonly store: OrchestrationStore,
    private readonly agents: AgentAccessPort,
    private readonly driver: OrchestrationExecutionDriver,
    private readonly pricing?: PricingTable,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /**
   * Resolves once the most recently scheduled background intent elaboration
   * for this orchestration has settled (successfully or not). Intent
   * elaboration runs asynchronously so `POST .../orchestrations` and
   * `PATCH .../intent` can return 202 immediately; this hook exists so
   * automated tests can assert on the outcome deterministically instead of
   * racing a background task.
   */
  async waitForPendingWork(orchestrationId: string): Promise<void> {
    await (this.pendingElaborations.get(orchestrationId) ?? Promise.resolve());
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
      // The remaining sink operations (events, tasks, application maps,
      // context packets, attempts, artifacts, verifications) belong to the
      // execution-evidence capabilities that are out of scope for this
      // restricted build (intent/contract/amendment/estimate/budget only).
      // They are safe no-ops so the frozen driver interface is fully
      // satisfiable by a driver that does use them (Task 2's real engine).
      recordEvent: async () => undefined,
      upsertTask: async () => undefined,
      recordApplicationMap: async () => undefined,
      recordContextPacket: async () => undefined,
      recordAttempt: async () => undefined,
      publishArtifact: async () => undefined,
      recordVerification: async () => undefined,
    };
  }

  private getOrchestrationOrThrow(db: { orchestrations: Orchestration[] }, id: string): Orchestration {
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
    });

    this.scheduleElaboration(orchestration.id, agent.workspacePath, prompt);
    return orchestration;
  }

  async reviseIntent(orchestrationId: string, note: string): Promise<Orchestration> {
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      throw new HttpError(400, "Revision note must not be empty");
    }
    const agentIdAndWorkspace = await this.store.mutate((db) => {
      const orchestration = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(orchestration.status, "drafting-intent");
      orchestration.status = "drafting-intent";
      orchestration.updatedAt = now();
      return { agentId: orchestration.agentId };
    });
    const agent = this.agents.getAgent(agentIdAndWorkspace.agentId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    this.scheduleElaboration(orchestrationId, agent.workspacePath, trimmedNote);
    return this.getOrchestration(orchestrationId);
  }

  private scheduleElaboration(orchestrationId: string, workspacePath: string, prompt: string): void {
    const promise = this.runElaboration(orchestrationId, workspacePath, prompt).catch(
      async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.mutate((db) => {
          const orchestration = db.orchestrations.find((item) => item.id === orchestrationId);
          if (!orchestration) return;
          orchestration.error = redactDeep(message);
          orchestration.updatedAt = now();
        });
      },
    );
    this.pendingElaborations.set(orchestrationId, promise);
    void promise;
  }

  private async runElaboration(
    orchestrationId: string,
    workspacePath: string,
    prompt: string,
  ): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId);
    const sink = this.buildSink(orchestrationId);
    const controller = new AbortController();
    const { draft, estimate } = await this.driver.elaborateIntent(
      {
        orchestrationId,
        agentId: orchestration.agentId,
        prompt,
        requestedMode: orchestration.requestedMode,
        budget: orchestration.budget,
        workspacePath,
      },
      sink,
      controller.signal,
    );
    await this.store.mutate((db) => {
      const item = this.getOrchestrationOrThrow(db, orchestrationId);
      assertLegalTransition(item.status, "awaiting-confirmation");
      const revisionNumber = db.intentDrafts.filter(
        (existing) => existing.orchestrationId === orchestrationId,
      ).length;
      const safeDraft: IntentDraft = redactDeep({
        ...emptyDraft(orchestrationId),
        ...draft,
        id: draft.id || randomUUID(),
        orchestrationId,
        revision: revisionNumber,
        createdAt: now(),
      });
      db.intentDrafts.push(safeDraft);
      item.currentIntentDraftId = safeDraft.id;
      item.estimate = redactDeep(estimate);
      item.status = "awaiting-confirmation";
      item.error = null;
      item.updatedAt = now();
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
      if (draft.materialQuestions.length > 0) {
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
      return contract;
    });
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
        requirements: input.requirements ?? baseDraft.requirements,
        assumptions: input.assumptions ?? baseDraft.assumptions,
        nonGoals: input.nonGoals ?? baseDraft.nonGoals,
        architectureDecisions: input.architectureDecisions ?? baseDraft.architectureDecisions,
        materialQuestions: input.materialQuestions ?? [],
        manualExpectations: input.manualExpectations ?? baseDraft.manualExpectations,
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
      return amendment;
    });
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
      const criteria =
        amendment.proposedCriteria ?? deriveCriteria(amendment.proposedIntent);
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
      return amendment;
    });
  }
}

/**
 * Minimal cross-task adapter described in the spec's section 6.1: lets
 * direct Playground execution (owned by Task 2's AgentService) and
 * orchestration cancellation (owned by this control plane) avoid racing on
 * the same Agent workspace. Wiring it into AgentService is a Final Assembly
 * step; this restricted build only guarantees the adapter's own behavior.
 */
export interface OrchestrationCoordinator {
  assertAgentAvailableForDirect(agentId: string): void;
  hasActiveOrchestration(agentId: string): boolean;
  cancelForAgent(agentId: string): Promise<void>;
}

export function createOrchestrationCoordinator(
  store: OrchestrationStore,
): OrchestrationCoordinator {
  const hasActive = (agentId: string): boolean =>
    store
      .snapshot()
      .orchestrations.some(
        (item) => item.agentId === agentId && !TERMINAL_STATUSES.has(item.status),
      );

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
      // Status-only stub: this restricted build does not hold a reference to
      // the execution driver, so it cannot abort in-flight model calls. Full
      // cancellation (driver.cancel, AbortController wiring, restart
      // reconciliation) is part of Task 1's fuller scope and was not
      // requested for this delivery; see the handoff for the limitation.
      await store.mutate((db) => {
        for (const orchestration of db.orchestrations) {
          if (orchestration.agentId === agentId && !TERMINAL_STATUSES.has(orchestration.status)) {
            orchestration.status = "cancelled";
            orchestration.error = "Cancelled because the Agent was stopped or deleted";
            orchestration.updatedAt = now();
            orchestration.completedAt = now();
          }
        }
      });
    },
  };
}
