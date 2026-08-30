import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type {
  ApplicationMapSummary,
  BudgetDecision,
  BudgetPolicy,
  ContextPacketSummary,
  ContractAmendment,
  ContractCriterion,
  CostEstimate,
  ExecutionContract,
  ExecutionOutcome,
  IntentDraft,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationStatus,
  OrchestrationTask,
  RequestedExecutionMode,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import {
  applyUsage,
  createBudgetState,
  DEFAULT_BUDGET_POLICY,
  emptyUsageLedger,
  evaluateContextExpansion,
  evaluateModelCall,
  evaluateWorkerAttempt,
  normalizeBudgetPolicy,
  normalizeTokenUsage,
  PricingBook,
  type BudgetContext,
  type BudgetOverrides,
  type PricingTable,
} from "./budget-ledger.js";
import {
  buildReadModel,
  listOrchestrationsForAgent,
  type OrchestrationReadModel,
} from "./read-model.js";
import { redactForResponse, redactRecord } from "./redaction.js";
import {
  assertTransition,
  canTransition,
  completionPath,
  INTERRUPTIBLE_STATUSES,
  isTerminalStatus,
  WORKSPACE_ACTIVE_STATUSES,
} from "./state-machine.js";
import type {
  BudgetState,
  OrchestrationDatabase,
  WorkspaceDisposition,
} from "./store.js";
import { OrchestrationStore } from "./store.js";

/**
 * Durable orchestration control plane.
 *
 * Owns lifecycle transitions, intent and contract versions, redaction,
 * usage/budget accounting, event recording, cancellation and restart
 * reconciliation. It calls an injected {@link OrchestrationExecutionDriver};
 * it contains no planner, worker, verifier or integrator model logic.
 */

/** Authoritative Agent facts the control plane needs. Implemented over `AgentService`. */
export interface AgentAccessSummary {
  id: string;
  status: "ready" | "busy" | "stopped" | "error";
  workspacePath: string;
}

/** Small injected port for Agent lookup, status and workspace path. */
export interface AgentAccessPort {
  getAgent(agentId: string): Promise<AgentAccessSummary | null>;
}

/**
 * Coordinator surface consumed by `AgentService` after Final Assembly so
 * direct Playground runs and orchestrated execution cannot race on one
 * Agent workspace. Task 2 adds an optional, default-no-op port with these
 * operations; Final Assembly injects
 * {@link createAgentExecutionCoordinator}.
 */
export interface AgentExecutionCoordinator {
  /** Throws `HttpError(409)` when orchestration currently owns the workspace. */
  assertAgentAvailableForDirect(agentId: string): Promise<void>;
  /** True when any non-terminal orchestration exists for the Agent. */
  hasActiveOrchestration(agentId: string): Promise<boolean>;
  /** Cancels every non-terminal orchestration for the Agent; returns the count. */
  cancelForAgent(agentId: string): Promise<number>;
}

export interface ContextExpansionRequest {
  taskId: string;
  executionId: string | null;
  reason: string;
  requestedPath: string;
}

export type ContextExpansionDecision =
  | { allowed: true; expansionId: string }
  | { allowed: false; reason: string };

/**
 * Additive control-plane extension of the frozen {@link OrchestrationSink}.
 *
 * The frozen contract has no enforcement point for retries, context
 * expansions or lifecycle stage announcements, all of which section 6.6 and
 * 6.7 require. The object handed to the driver implements both interfaces, so
 * a Task 2 driver typed against the frozen `OrchestrationSink` keeps working
 * and may feature-detect these methods.
 */
export interface ControlPlaneSink extends OrchestrationSink {
  reserveWorkerAttempt(input: {
    taskId: string;
    executionId: string | null;
  }): Promise<BudgetDecision>;
  requestContextExpansion(
    request: ContextExpansionRequest,
  ): Promise<ContextExpansionDecision>;
  markIntegrating(summary: string): Promise<void>;
  markVerifying(summary: string): Promise<void>;
  recordWorkspaceDisposition(
    disposition: Omit<WorkspaceDisposition, "orchestrationId" | "recordedAt">,
  ): Promise<void>;
}

export interface OrchestrationControlServiceOptions {
  store: OrchestrationStore;
  driver: OrchestrationExecutionDriver;
  agents: AgentAccessPort;
  /** Per-model prices. An empty table means every dollar figure is `null`. */
  pricing?: PricingTable | undefined;
  defaultBudget?: BudgetPolicy | undefined;
  clock?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
  logger?: { error(message: string, error?: unknown): void } | undefined;
}

export interface CreateOrchestrationInput {
  agentId: string;
  prompt: string;
  requestedMode: RequestedExecutionMode;
  budget?: BudgetOverrides | undefined;
}

export interface ConfirmIntentInput {
  /** Must be the literal `true`. Confirmation is never inferred. */
  confirm: true;
  /** One answer per unresolved material question, in order. */
  answers?: string[] | undefined;
  /** Optional explicit acceptance criteria replacing the derived set. */
  criteria?: ContractCriterion[] | undefined;
}

/** Stable event type names. Task 3 filters on these. */
export const ORCHESTRATION_EVENT_TYPES = {
  created: "orchestration.created",
  statusChanged: "orchestration.status-changed",
  restartReconciled: "orchestration.restart-reconciled",
  intentDrafted: "intent.drafted",
  intentRevisionRequested: "intent.revision-requested",
  estimateRecorded: "estimate.recorded",
  contractConfirmed: "contract.confirmed",
  planRecorded: "plan.recorded",
  executionStarted: "execution.started",
  budgetReserved: "budget.reserved",
  budgetDenied: "budget.denied",
  usageCommitted: "usage.committed",
  usageOrphaned: "usage.orphaned",
  taskUpserted: "task.upserted",
  applicationMapRecorded: "application-map.recorded",
  contextPacketRecorded: "context-packet.recorded",
  contextExpansionGranted: "context.expansion-granted",
  contextExpansionDenied: "context.expansion-denied",
  workerAttemptReserved: "worker.attempt-reserved",
  workerAttemptDenied: "worker.attempt-denied",
  attemptRecorded: "worker.attempt-recorded",
  artifactPublished: "artifact.published",
  artifactDependencyStale: "artifact.dependency-stale",
  verificationRecorded: "verification.recorded",
  integrationStarted: "integration.started",
  verificationStarted: "verification.started",
  amendmentPending: "amendment.pending",
  amendmentConfirmed: "amendment.confirmed",
  amendmentRejected: "amendment.rejected",
  workspaceDisposition: "workspace.disposition",
  cancelled: "orchestration.cancelled",
  cancellationReconciled: "orchestration.cancellation-reconciled",
  completed: "orchestration.completed",
  failed: "orchestration.failed",
  budgetExhausted: "orchestration.budget-exhausted",
  outcomeIgnored: "orchestration.outcome-ignored",
} as const;

const MAX_EVENTS_PER_ORCHESTRATION = 1_000;
const MAX_TOTAL_EVENTS = 10_000;
const MAX_PROMPT_LENGTH = 20_000;

type EventInput = Omit<OrchestrationEvent, "id" | "createdAt">;
type EventMetadata = OrchestrationEvent["metadata"];

function toText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function toStringArray(value: unknown, maxItems = 100, itemLimit = 2_000): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => item.slice(0, itemLimit));
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OrchestrationControlService {
  private readonly store: OrchestrationStore;
  private readonly driver: OrchestrationExecutionDriver;
  private readonly agents: AgentAccessPort;
  private readonly pricing: PricingBook;
  private readonly defaultBudget: BudgetPolicy;
  private readonly clock: () => Date;
  private readonly newId: () => string;
  private readonly logger: { error(message: string, error?: unknown): void } | undefined;

  private readonly controllers = new Map<string, AbortController>();
  private readonly activeWork = new Map<string, Promise<void>>();

  constructor(options: OrchestrationControlServiceOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.agents = options.agents;
    this.pricing = new PricingBook(options.pricing ?? {});
    this.defaultBudget = options.defaultBudget ?? DEFAULT_BUDGET_POLICY;
    this.clock = options.clock ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.logger = options.logger;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Loads the store and reconciles execution states that could not have
   * survived the restart. Interrupted work is cancelled with an explicit
   * reason; it is never reported as successful.
   */
  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.mutate((database) => {
      const timestamp = this.now();
      for (const orchestration of database.orchestrations) {
        if (!INTERRUPTIBLE_STATUSES.has(orchestration.status)) {
          continue;
        }
        const from = orchestration.status;
        assertTransition(from, "cancelled");
        orchestration.status = "cancelled";
        orchestration.error =
          "Server restarted while this orchestration was in " + from;
        orchestration.updatedAt = timestamp;
        orchestration.completedAt = timestamp;
        this.reconcileChildren(database, orchestration.id, timestamp);
        this.pushEvent(database, {
          orchestrationId: orchestration.id,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.restartReconciled,
          actorRole: "control-plane",
          modelId: null,
          summary:
            "Interrupted orchestration reconciled to cancelled after restart",
          metadata: { previousStatus: from },
        });
        this.pushStatusEvent(database, orchestration.id, from, "cancelled", {
          reason: "restart-reconciliation",
        });
      }
    });
  }

  // ------------------------------------------------------------------ queries

  async listOrchestrations(agentId: string): Promise<Orchestration[]> {
    await this.requireAgent(agentId);
    return listOrchestrationsForAgent(this.store.snapshot(), agentId);
  }

  getOrchestration(orchestrationId: string): OrchestrationReadModel {
    const model = buildReadModel(this.store.snapshot(), orchestrationId, {
      nowMs: this.clock().getTime(),
    });
    if (!model) {
      throw new HttpError(404, "Orchestration not found");
    }
    return model;
  }

  listEvents(
    orchestrationId: string,
    options: { limit?: number | undefined; afterEventId?: string | undefined } = {},
  ): OrchestrationEvent[] {
    const model = buildReadModel(this.store.snapshot(), orchestrationId, {
      nowMs: this.clock().getTime(),
      ...(options.limit === undefined ? {} : { eventLimit: options.limit }),
      ...(options.afterEventId === undefined
        ? {}
        : { afterEventId: options.afterEventId }),
    });
    if (!model) {
      throw new HttpError(404, "Orchestration not found");
    }
    return model.events;
  }

  listTasks(orchestrationId: string): OrchestrationTask[] {
    return this.getOrchestration(orchestrationId).tasks;
  }

  listArtifacts(orchestrationId: string): SharedArtifact[] {
    return this.getOrchestration(orchestrationId).artifacts;
  }

  listVerifications(orchestrationId: string): VerificationRecord[] {
    return this.getOrchestration(orchestrationId).verifications;
  }

  /** Test and shutdown helper: resolves once no background phase is in flight. */
  async whenSettled(orchestrationId: string): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      const work = this.activeWork.get(orchestrationId);
      if (!work) {
        return;
      }
      await work.catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ intent phase

  /**
   * Validates the request, persists a `drafting-intent` orchestration under
   * the atomic one-active-orchestration-per-Agent rule, then elaborates the
   * intent asynchronously.
   */
  async createOrchestration(input: CreateOrchestrationInput): Promise<Orchestration> {
    const agent = await this.requireAgent(input.agentId);
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before creating an orchestration");
    }
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      throw new HttpError(400, "Prompt is required");
    }

    const timestamp = this.now();
    const budget = normalizeBudgetPolicy(input.budget, this.defaultBudget);
    const orchestration: Orchestration = {
      id: this.newId(),
      agentId: agent.id,
      prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
      requestedMode: input.requestedMode,
      selectedMode: null,
      status: "drafting-intent",
      currentIntentDraftId: null,
      activeContractId: null,
      estimate: null,
      budget,
      usage: emptyUsageLedger(this.pricing.isConfigured),
      finalOutput: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };

    await this.store.mutate((database) => {
      const active = database.orchestrations.find(
        (item) => item.agentId === agent.id && !isTerminalStatus(item.status),
      );
      if (active) {
        throw new HttpError(
          409,
          "This Agent already has an active orchestration (" + active.id + ")",
        );
      }
      database.orchestrations.push(structuredClone(orchestration));
      database.budgetStates.push(createBudgetState(orchestration.id, timestamp));
      this.pushEvent(database, {
        orchestrationId: orchestration.id,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.created,
        actorRole: "user",
        modelId: null,
        summary: "Orchestration created in mode " + input.requestedMode,
        metadata: {
          requestedMode: input.requestedMode,
          maxModelCalls: budget.maxModelCalls,
          maxWallClockMs: budget.maxWallClockMs,
          pricingStatus: orchestration.usage.pricingStatus,
        },
      });
    });

    this.startPhase(orchestration.id, (signal) =>
      this.runIntentElaboration(orchestration.id, orchestration.prompt, signal),
    );
    return redactForResponse(structuredClone(orchestration));
  }

  /** Records a user revision request and re-elaborates as a new draft revision. */
  async reviseIntent(orchestrationId: string, feedback: string): Promise<Orchestration> {
    const trimmed = feedback.trim();
    if (trimmed.length === 0) {
      throw new HttpError(400, "Revision feedback is required");
    }
    const current = this.requireOrchestration(orchestrationId);
    const updated = await this.transition(orchestrationId, "drafting-intent", {
      summary: "User requested an intent revision",
      actorRole: "user",
      metadata: { feedbackLength: trimmed.length },
      beforeStatusEvent: (database) => {
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.intentRevisionRequested,
          actorRole: "user",
          modelId: null,
          summary: "Revision requested: " + trimmed.slice(0, 500),
          metadata: {},
        });
      },
    });

    const prompt = this.composeRevisionPrompt(current, trimmed);
    this.startPhase(orchestrationId, (signal) =>
      this.runIntentElaboration(orchestrationId, prompt, signal),
    );
    return updated;
  }

  /**
   * Explicit user confirmation. Creates an immutable versioned
   * {@link ExecutionContract} and only then allows planning to begin.
   */
  async confirmIntent(
    orchestrationId: string,
    input: ConfirmIntentInput,
  ): Promise<{ orchestration: Orchestration; contract: ExecutionContract }> {
    if (input.confirm !== true) {
      throw new HttpError(422, "Explicit confirmation is required");
    }
    const snapshot = this.store.snapshot();
    const orchestration = this.requireOrchestration(orchestrationId, snapshot);
    assertTransition(orchestration.status, "planning");

    const draft = snapshot.intentDrafts.find(
      (item) => item.id === orchestration.currentIntentDraftId,
    );
    if (!draft) {
      throw new HttpError(422, "There is no intent draft to confirm");
    }

    const answers = toStringArray(input.answers, 50).filter(
      (answer) => answer.trim().length > 0,
    );
    if (draft.materialQuestions.length > 0 && answers.length < draft.materialQuestions.length) {
      throw new HttpError(
        422,
        "Answer all " +
          draft.materialQuestions.length +
          " material questions before confirming",
      );
    }

    const criteria =
      input.criteria && input.criteria.length > 0
        ? this.normalizeCriteria(input.criteria)
        : null;

    const timestamp = this.now();
    let contract!: ExecutionContract;

    const updated = await this.store.mutate((database) => {
      const stored = this.mustFind(database, orchestrationId);
      assertTransition(stored.status, "planning");
      const from = stored.status;

      let confirmedDraft = database.intentDrafts.find(
        (item) => item.id === stored.currentIntentDraftId,
      );
      if (!confirmedDraft) {
        throw new HttpError(422, "There is no intent draft to confirm");
      }

      // Answering material questions produces a new immutable draft revision
      // rather than mutating the reviewed one.
      if (confirmedDraft.materialQuestions.length > 0) {
        const resolved: IntentDraft = {
          ...structuredClone(confirmedDraft),
          id: this.newId(),
          revision: this.nextDraftRevision(database, orchestrationId),
          assumptions: [
            ...confirmedDraft.assumptions,
            ...confirmedDraft.materialQuestions.map(
              (question, index) =>
                "Answered: " + question + " -> " + (answers[index] ?? ""),
            ),
          ],
          materialQuestions: [],
          createdAt: timestamp,
        };
        database.intentDrafts.push(resolved);
        stored.currentIntentDraftId = resolved.id;
        confirmedDraft = resolved;
      }

      const previousVersion = database.contracts
        .filter((item) => item.orchestrationId === orchestrationId)
        .reduce((highest, item) => Math.max(highest, item.version), 0);

      contract = {
        id: this.newId(),
        orchestrationId,
        version: previousVersion + 1,
        intent: structuredClone(confirmedDraft),
        criteria: criteria ?? this.deriveCriteria(confirmedDraft),
        confirmedBy: "user",
        confirmedAt: timestamp,
        supersedesContractId: stored.activeContractId,
      };
      database.contracts.push(structuredClone(contract));
      stored.activeContractId = contract.id;
      stored.status = "planning";
      stored.updatedAt = timestamp;

      this.pushEvent(database, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.contractConfirmed,
        actorRole: "user",
        modelId: null,
        summary:
          "User confirmed execution contract v" +
          contract.version +
          " with " +
          contract.criteria.length +
          " acceptance criteria",
        metadata: {
          contractId: contract.id,
          contractVersion: contract.version,
          criteriaCount: contract.criteria.length,
          supersedesContractId: contract.supersedesContractId,
        },
      });
      this.pushStatusEvent(database, orchestrationId, from, "planning", {
        contractVersion: contract.version,
      });
      return redactForResponse(structuredClone(stored));
    });

    this.startPhase(orchestrationId, (signal) => this.runPlanning(orchestrationId, signal));
    return { orchestration: updated, contract: redactForResponse(contract) };
  }

  // --------------------------------------------------------- execution phase

  /** Explicit start. Planning results are never executed just because they exist. */
  async startExecution(orchestrationId: string): Promise<Orchestration> {
    const updated = await this.transition(orchestrationId, "running", {
      summary: "User started orchestrated execution",
      actorRole: "user",
      metadata: {},
      beforeStatusEvent: (database) => {
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.executionStarted,
          actorRole: "control-plane",
          modelId: null,
          summary: "Execution accepted and handed to the execution driver",
          metadata: {},
        });
      },
    });
    this.startPhase(orchestrationId, (signal) => this.runExecution(orchestrationId, signal));
    return updated;
  }

  /**
   * Aborts the signal, asks the driver to cancel, reconciles child records and
   * persists `cancelled`. Idempotent; still available after a budget stop,
   * where it releases child work without overwriting the terminal state.
   */
  async cancel(orchestrationId: string, reason = "Cancelled by user"): Promise<Orchestration> {
    const current = this.requireOrchestration(orchestrationId);

    if (current.status === "cancelled") {
      return redactForResponse(current);
    }
    if (current.status === "budget-exhausted") {
      await this.releaseChildWork(orchestrationId, "budget-stop-cleanup");
      return redactForResponse(this.requireOrchestration(orchestrationId));
    }
    if (isTerminalStatus(current.status)) {
      throw new HttpError(
        409,
        "Orchestration already finished with status " + current.status,
      );
    }

    const updated = await this.transition(orchestrationId, "cancelled", {
      summary: reason,
      actorRole: "user",
      metadata: { reason },
      error: reason,
      beforeStatusEvent: (database) => {
        this.reconcileChildren(database, orchestrationId, this.now());
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.cancelled,
          actorRole: "user",
          modelId: null,
          summary: reason,
          metadata: {},
        });
      },
    });

    await this.releaseChildWork(orchestrationId, reason);
    return updated;
  }

  // -------------------------------------------------------------- amendments

  /**
   * Confirms a pending material amendment. This creates the next immutable
   * contract version and returns to planning; the contract is never weakened
   * silently to make a failing task pass.
   */
  async confirmAmendment(
    orchestrationId: string,
    amendmentId: string,
  ): Promise<{ orchestration: Orchestration; contract: ExecutionContract }> {
    const timestamp = this.now();
    let contract!: ExecutionContract;

    const updated = await this.store.mutate((database) => {
      const stored = this.mustFind(database, orchestrationId);
      const amendment = database.amendments.find(
        (item) => item.id === amendmentId && item.orchestrationId === orchestrationId,
      );
      if (!amendment) {
        throw new HttpError(404, "Amendment not found");
      }
      if (amendment.status !== "pending") {
        throw new HttpError(422, "Amendment already " + amendment.status);
      }
      assertTransition(stored.status, "planning");
      const from = stored.status;

      const baseContract = database.contracts.find(
        (item) => item.id === amendment.baseContractId,
      );
      const proposedDraft: IntentDraft = {
        ...structuredClone(amendment.proposedIntent),
        id: this.newId(),
        orchestrationId,
        revision: this.nextDraftRevision(database, orchestrationId),
        createdAt: timestamp,
      };
      database.intentDrafts.push(proposedDraft);
      stored.currentIntentDraftId = proposedDraft.id;

      const previousVersion = database.contracts
        .filter((item) => item.orchestrationId === orchestrationId)
        .reduce((highest, item) => Math.max(highest, item.version), 0);

      contract = {
        id: this.newId(),
        orchestrationId,
        version: previousVersion + 1,
        intent: structuredClone(proposedDraft),
        criteria:
          amendment.proposedCriteria && amendment.proposedCriteria.length > 0
            ? this.normalizeCriteria(amendment.proposedCriteria)
            : structuredClone(baseContract?.criteria ?? []),
        confirmedBy: "user",
        confirmedAt: timestamp,
        supersedesContractId: amendment.baseContractId,
      };
      database.contracts.push(structuredClone(contract));

      amendment.status = "confirmed";
      amendment.decidedAt = timestamp;
      stored.activeContractId = contract.id;
      stored.status = "planning";
      stored.error = null;
      stored.updatedAt = timestamp;

      this.pushEvent(database, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.amendmentConfirmed,
        actorRole: "user",
        modelId: null,
        summary:
          "User confirmed amendment; contract v" + contract.version + " is now active",
        metadata: {
          amendmentId,
          contractVersion: contract.version,
          material: amendment.material,
        },
      });
      this.pushStatusEvent(database, orchestrationId, from, "planning", {
        amendmentId,
      });
      return redactForResponse(structuredClone(stored));
    });

    this.startPhase(orchestrationId, (signal) => this.runPlanning(orchestrationId, signal));
    return { orchestration: updated, contract: redactForResponse(contract) };
  }

  /** Rejects a pending amendment and returns the user to intent confirmation. */
  async rejectAmendment(
    orchestrationId: string,
    amendmentId: string,
    reason = "Amendment rejected by user",
  ): Promise<Orchestration> {
    const timestamp = this.now();
    return this.store.mutate((database) => {
      const stored = this.mustFind(database, orchestrationId);
      const amendment = database.amendments.find(
        (item) => item.id === amendmentId && item.orchestrationId === orchestrationId,
      );
      if (!amendment) {
        throw new HttpError(404, "Amendment not found");
      }
      if (amendment.status !== "pending") {
        throw new HttpError(422, "Amendment already " + amendment.status);
      }
      assertTransition(stored.status, "awaiting-confirmation");
      const from = stored.status;
      amendment.status = "rejected";
      amendment.decidedAt = timestamp;
      stored.status = "awaiting-confirmation";
      stored.updatedAt = timestamp;
      this.pushEvent(database, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.amendmentRejected,
        actorRole: "user",
        modelId: null,
        summary: reason,
        metadata: { amendmentId },
      });
      this.pushStatusEvent(database, orchestrationId, from, "awaiting-confirmation", {
        amendmentId,
      });
      return redactForResponse(structuredClone(stored));
    });
  }

  // ------------------------------------------------------------- coordinator

  async assertAgentAvailableForDirect(agentId: string): Promise<void> {
    const blocking = this.store
      .snapshot()
      .orchestrations.find(
        (item) => item.agentId === agentId && WORKSPACE_ACTIVE_STATUSES.has(item.status),
      );
    if (blocking) {
      throw new HttpError(
        409,
        "An orchestration is currently using this Agent workspace (" +
          blocking.id +
          "); cancel it before starting a direct run",
      );
    }
  }

  async hasActiveOrchestration(agentId: string): Promise<boolean> {
    return this.store
      .snapshot()
      .orchestrations.some(
        (item) => item.agentId === agentId && !isTerminalStatus(item.status),
      );
  }

  async cancelForAgent(agentId: string): Promise<number> {
    const targets = this.store
      .snapshot()
      .orchestrations.filter(
        (item) => item.agentId === agentId && !isTerminalStatus(item.status),
      );
    let cancelled = 0;
    for (const target of targets) {
      try {
        await this.cancel(target.id, "Cancelled because the Agent was stopped or deleted");
        cancelled += 1;
      } catch (error) {
        this.logger?.error("Failed to cancel orchestration " + target.id, error);
      }
    }
    return cancelled;
  }

  // ---------------------------------------------------------- driver phases

  private async runIntentElaboration(
    orchestrationId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    const snapshot = this.store.snapshot();
    const orchestration = snapshot.orchestrations.find(
      (item) => item.id === orchestrationId,
    );
    if (!orchestration || orchestration.status !== "drafting-intent") {
      return;
    }
    const agent = await this.agents.getAgent(orchestration.agentId);
    if (!agent) {
      await this.failOrchestration(orchestrationId, "Agent no longer exists");
      return;
    }

    try {
      const result = await this.driver.elaborateIntent(
        {
          orchestrationId,
          agentId: orchestration.agentId,
          prompt,
          requestedMode: orchestration.requestedMode,
          budget: orchestration.budget,
          workspacePath: agent.workspacePath,
        },
        this.createSink(orchestrationId),
        signal,
      );
      if (this.isResolved(orchestrationId)) {
        return;
      }
      await this.persistIntentResult(orchestrationId, result.draft, result.estimate);
    } catch (error) {
      await this.handlePhaseError(orchestrationId, error, signal);
    }
  }

  private async persistIntentResult(
    orchestrationId: string,
    rawDraft: IntentDraft,
    rawEstimate: CostEstimate,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      const stored = this.mustFind(database, orchestrationId);
      assertTransition(stored.status, "awaiting-confirmation");
      const from = stored.status;

      const draft: IntentDraft = {
        id: this.newId(),
        orchestrationId,
        revision: this.nextDraftRevision(database, orchestrationId),
        goal: toText(rawDraft?.goal, 2_000),
        requirements: toStringArray(rawDraft?.requirements),
        assumptions: toStringArray(rawDraft?.assumptions),
        nonGoals: toStringArray(rawDraft?.nonGoals),
        architectureDecisions: toStringArray(rawDraft?.architectureDecisions),
        materialQuestions: toStringArray(rawDraft?.materialQuestions, 20),
        manualExpectations: toStringArray(rawDraft?.manualExpectations),
        createdAt: timestamp,
      };
      database.intentDrafts.push(draft);

      const estimate = this.normalizeEstimate(rawEstimate);
      stored.currentIntentDraftId = draft.id;
      stored.estimate = estimate;
      stored.status = "awaiting-confirmation";
      stored.updatedAt = timestamp;

      this.pushEvent(database, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.intentDrafted,
        actorRole: "planner",
        modelId: null,
        summary: "Intent draft revision " + draft.revision + ": " + draft.goal,
        metadata: {
          revision: draft.revision,
          requirements: draft.requirements.length,
          assumptions: draft.assumptions.length,
          materialQuestions: draft.materialQuestions.length,
        },
      });
      this.pushEvent(database, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.estimateRecorded,
        actorRole: "planner",
        modelId: null,
        summary:
          "Pre-execution estimate recorded with pricing status " + estimate.pricingStatus,
        metadata: {
          inputTokenLow: estimate.inputTokenLow,
          inputTokenHigh: estimate.inputTokenHigh,
          outputTokenLow: estimate.outputTokenLow,
          outputTokenHigh: estimate.outputTokenHigh,
          estimatedUsdLow: estimate.estimatedUsdLow,
          estimatedUsdHigh: estimate.estimatedUsdHigh,
          pricingStatus: estimate.pricingStatus,
        },
      });
      this.pushStatusEvent(database, orchestrationId, from, "awaiting-confirmation", {
        revision: draft.revision,
      });
    });
  }

  private async runPlanning(orchestrationId: string, signal: AbortSignal): Promise<void> {
    const snapshot = this.store.snapshot();
    const orchestration = snapshot.orchestrations.find(
      (item) => item.id === orchestrationId,
    );
    if (!orchestration || orchestration.status !== "planning") {
      return;
    }
    const contract = snapshot.contracts.find(
      (item) => item.id === orchestration.activeContractId,
    );
    if (!contract) {
      await this.failOrchestration(orchestrationId, "Planning requires a confirmed contract");
      return;
    }
    const agent = await this.agents.getAgent(orchestration.agentId);
    if (!agent) {
      await this.failOrchestration(orchestrationId, "Agent no longer exists");
      return;
    }

    try {
      const plan = await this.driver.plan(
        { orchestration, contract, workspacePath: agent.workspacePath },
        this.createSink(orchestrationId),
        signal,
      );
      if (this.isResolved(orchestrationId)) {
        return;
      }
      const timestamp = this.now();
      await this.store.mutate((database) => {
        const stored = this.mustFind(database, orchestrationId);
        assertTransition(stored.status, "ready");
        const from = stored.status;

        const tasks = (Array.isArray(plan.tasks) ? plan.tasks : []).map((task) =>
          this.normalizeTask(task, orchestrationId),
        );
        for (const task of tasks) {
          const index = database.tasks.findIndex((item) => item.id === task.id);
          if (index >= 0) {
            database.tasks[index] = task;
          } else {
            database.tasks.push(task);
          }
        }
        const map = this.normalizeApplicationMap(plan.applicationMap, orchestrationId, timestamp);
        if (!database.applicationMaps.some((item) => item.orchestrationId === orchestrationId && item.version === map.version)) {
          database.applicationMaps.push(map);
        }

        const planRecord = {
          orchestrationId,
          selectedMode: plan.selectedMode,
          routeReason: toText(plan.routeReason, 1_000),
          applicationMapVersion: map.version,
          taskIds: tasks.map((task) => task.id),
          createdAt: timestamp,
        };
        const existing = database.plans.findIndex(
          (item) => item.orchestrationId === orchestrationId,
        );
        if (existing >= 0) {
          database.plans[existing] = planRecord;
        } else {
          database.plans.push(planRecord);
        }

        stored.selectedMode = plan.selectedMode;
        stored.status = "ready";
        stored.updatedAt = timestamp;

        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.planRecorded,
          actorRole: "planner",
          modelId: null,
          summary:
            "Route " + plan.selectedMode + " selected: " + planRecord.routeReason,
          metadata: {
            selectedMode: plan.selectedMode,
            taskCount: tasks.length,
            applicationMapVersion: map.version,
          },
        });
        this.pushStatusEvent(database, orchestrationId, from, "ready", {
          selectedMode: plan.selectedMode,
        });
      });
    } catch (error) {
      await this.handlePhaseError(orchestrationId, error, signal);
    }
  }

  private async runExecution(orchestrationId: string, signal: AbortSignal): Promise<void> {
    const snapshot = this.store.snapshot();
    const orchestration = snapshot.orchestrations.find(
      (item) => item.id === orchestrationId,
    );
    if (!orchestration || orchestration.status !== "running") {
      return;
    }
    const contract = snapshot.contracts.find(
      (item) => item.id === orchestration.activeContractId,
    );
    const planRecord = snapshot.plans.find(
      (item) => item.orchestrationId === orchestrationId,
    );
    const applicationMap = snapshot.applicationMaps
      .filter((item) => item.orchestrationId === orchestrationId)
      .sort((left, right) => right.version - left.version)[0];
    if (!contract || !planRecord || !applicationMap) {
      await this.failOrchestration(
        orchestrationId,
        "Execution requires a confirmed contract and a recorded plan",
      );
      return;
    }
    const agent = await this.agents.getAgent(orchestration.agentId);
    if (!agent) {
      await this.failOrchestration(orchestrationId, "Agent no longer exists");
      return;
    }

    try {
      const outcome = await this.driver.execute(
        {
          orchestration,
          contract,
          workspacePath: agent.workspacePath,
          plan: {
            selectedMode: planRecord.selectedMode,
            routeReason: planRecord.routeReason,
            tasks: snapshot.tasks.filter((task) => task.orchestrationId === orchestrationId),
            applicationMap,
          },
        },
        this.createSink(orchestrationId),
        signal,
      );
      await this.applyOutcome(orchestrationId, outcome);
    } catch (error) {
      await this.handlePhaseError(orchestrationId, error, signal);
    }
  }

  /**
   * Applies a driver outcome. A terminal orchestration is never overwritten, so
   * a late "completed" after a cancellation or budget stop cannot produce an
   * invalid success state.
   */
  private async applyOutcome(
    orchestrationId: string,
    outcome: ExecutionOutcome,
  ): Promise<void> {
    const current = this.store
      .snapshot()
      .orchestrations.find((item) => item.id === orchestrationId);
    if (!current) {
      return;
    }
    if (isTerminalStatus(current.status)) {
      await this.recordEventOnly(orchestrationId, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.outcomeIgnored,
        actorRole: "control-plane",
        modelId: null,
        summary:
          "Driver reported " +
          outcome.kind +
          " after the orchestration already reached " +
          current.status,
        metadata: { outcome: outcome.kind, status: current.status },
      });
      return;
    }

    switch (outcome.kind) {
      case "completed": {
        const path = completionPath(current.status);
        for (const step of path) {
          const isFinal = step === "completed";
          await this.transition(orchestrationId, step, {
            summary:
              step === "integrating"
                ? "Deterministic integration stage entered"
                : step === "verifying"
                  ? "Global verification stage entered"
                  : "Verified result published",
            actorRole: "control-plane",
            metadata: {},
            ...(isFinal
              ? { finalOutput: toText(outcome.finalOutput, 20_000) }
              : {}),
            beforeStatusEvent: (database) => {
              if (step === "integrating") {
                this.pushEvent(database, {
                  orchestrationId,
                  taskId: null,
                  executionId: null,
                  type: ORCHESTRATION_EVENT_TYPES.integrationStarted,
                  actorRole: "integrator",
                  modelId: null,
                  summary: "Integration stage recorded by the control plane",
                  metadata: {},
                });
              }
              if (step === "verifying") {
                this.pushEvent(database, {
                  orchestrationId,
                  taskId: null,
                  executionId: null,
                  type: ORCHESTRATION_EVENT_TYPES.verificationStarted,
                  actorRole: "verifier",
                  modelId: null,
                  summary: "Global verification stage recorded by the control plane",
                  metadata: {},
                });
              }
              if (isFinal) {
                this.pushEvent(database, {
                  orchestrationId,
                  taskId: null,
                  executionId: null,
                  type: ORCHESTRATION_EVENT_TYPES.completed,
                  actorRole: "control-plane",
                  modelId: null,
                  summary: "Orchestration completed and published",
                  metadata: {},
                });
              }
            },
          });
        }
        return;
      }
      case "needs-user": {
        await this.persistAmendment(orchestrationId, outcome.amendment);
        return;
      }
      case "budget-exhausted": {
        await this.markBudgetExhausted(orchestrationId, outcome.reason);
        return;
      }
      case "cancelled": {
        await this.transition(orchestrationId, "cancelled", {
          summary: outcome.reason,
          actorRole: "control-plane",
          metadata: { reason: outcome.reason },
          error: outcome.reason,
          beforeStatusEvent: (database) => {
            this.reconcileChildren(database, orchestrationId, this.now());
            this.pushEvent(database, {
              orchestrationId,
              taskId: null,
              executionId: null,
              type: ORCHESTRATION_EVENT_TYPES.cancelled,
              actorRole: "control-plane",
              modelId: null,
              summary: outcome.reason,
              metadata: {},
            });
          },
        });
        return;
      }
      case "failed": {
        await this.failOrchestration(orchestrationId, outcome.reason);
        return;
      }
    }
  }

  private async persistAmendment(
    orchestrationId: string,
    rawAmendment: ContractAmendment,
  ): Promise<void> {
    const timestamp = this.now();
    await this.transition(orchestrationId, "needs-user", {
      summary: "A material amendment requires renewed user confirmation",
      actorRole: "control-plane",
      metadata: {},
      beforeStatusEvent: (database) => {
        const stored = this.mustFind(database, orchestrationId);
        const amendment: ContractAmendment = {
          id: this.newId(),
          orchestrationId,
          baseContractId: stored.activeContractId ?? "",
          proposedIntent: {
            ...structuredClone(rawAmendment.proposedIntent),
            orchestrationId,
          },
          proposedCriteria:
            rawAmendment.proposedCriteria && rawAmendment.proposedCriteria.length > 0
              ? this.normalizeCriteria(rawAmendment.proposedCriteria)
              : null,
          reason: toText(rawAmendment.reason, 1_000),
          material: rawAmendment.material !== false,
          status: "pending",
          createdAt: timestamp,
          decidedAt: null,
        };
        database.amendments.push(amendment);
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.amendmentPending,
          actorRole: "planner",
          modelId: null,
          summary: "Pending amendment: " + amendment.reason,
          metadata: {
            amendmentId: amendment.id,
            material: amendment.material,
            baseContractId: amendment.baseContractId,
          },
        });
      },
    });
  }

  private async markBudgetExhausted(orchestrationId: string, reason: string): Promise<void> {
    const current = this.store
      .snapshot()
      .orchestrations.find((item) => item.id === orchestrationId);
    if (!current || isTerminalStatus(current.status)) {
      return;
    }
    if (!canTransition(current.status, "budget-exhausted")) {
      await this.failOrchestration(orchestrationId, reason);
      return;
    }
    await this.transition(orchestrationId, "budget-exhausted", {
      summary: reason,
      actorRole: "control-plane",
      metadata: { reason },
      error: reason,
      beforeStatusEvent: (database) => {
        this.reconcileChildren(database, orchestrationId, this.now());
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.budgetExhausted,
          actorRole: "control-plane",
          modelId: null,
          summary: reason,
          metadata: {},
        });
      },
    });
    this.controllers.get(orchestrationId)?.abort();
    await this.driver.cancel(orchestrationId).catch((error) => {
      this.logger?.error("Driver cancel failed after budget stop", error);
    });
  }

  private async failOrchestration(orchestrationId: string, reason: string): Promise<void> {
    const current = this.store
      .snapshot()
      .orchestrations.find((item) => item.id === orchestrationId);
    if (!current || isTerminalStatus(current.status)) {
      return;
    }
    await this.transition(orchestrationId, "failed", {
      summary: reason,
      actorRole: "control-plane",
      metadata: { reason },
      error: reason,
      beforeStatusEvent: (database) => {
        this.reconcileChildren(database, orchestrationId, this.now());
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.failed,
          actorRole: "control-plane",
          modelId: null,
          summary: reason,
          metadata: {},
        });
      },
    });
  }

  private async handlePhaseError(
    orchestrationId: string,
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.isResolved(orchestrationId)) {
      return;
    }
    if (signal.aborted) {
      // Called from inside the running phase, so the public cancel() (which
      // waits for that phase to settle) must not be used here.
      const reason = "Cancelled while the driver was running";
      await this.transition(orchestrationId, "cancelled", {
        summary: reason,
        actorRole: "control-plane",
        metadata: { reason },
        error: reason,
        beforeStatusEvent: (database) => {
          this.reconcileChildren(database, orchestrationId, this.now());
          this.pushEvent(database, {
            orchestrationId,
            taskId: null,
            executionId: null,
            type: ORCHESTRATION_EVENT_TYPES.cancelled,
            actorRole: "control-plane",
            modelId: null,
            summary: reason,
            metadata: {},
          });
        },
      }).catch(() => undefined);
      return;
    }
    await this.failOrchestration(orchestrationId, errorMessage(error));
  }

  // -------------------------------------------------------------------- sink

  /**
   * Builds the sink handed to the driver. Every write is bound to one
   * orchestration id so a driver cannot record evidence against another run.
   */
  createSink(orchestrationId: string): ControlPlaneSink {
    const service = this;
    return {
      async reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision> {
        return service.reserveModelCall(orchestrationId, input);
      },
      async commitModelUsage(reservationId: string, actual: TokenUsage): Promise<void> {
        await service.commitModelUsage(orchestrationId, reservationId, actual);
      },
      async recordEvent(event: EventInput): Promise<void> {
        await service.recordEventOnly(orchestrationId, event);
      },
      async upsertTask(task: OrchestrationTask): Promise<void> {
        await service.upsertTask(orchestrationId, task);
      },
      async recordApplicationMap(map: ApplicationMapSummary): Promise<void> {
        await service.recordApplicationMap(orchestrationId, map);
      },
      async recordContextPacket(packet: ContextPacketSummary): Promise<void> {
        await service.recordContextPacket(orchestrationId, packet);
      },
      async recordAttempt(attempt: WorkerAttempt): Promise<void> {
        await service.recordAttempt(orchestrationId, attempt);
      },
      async publishArtifact(artifact: SharedArtifact): Promise<void> {
        await service.publishArtifact(orchestrationId, artifact);
      },
      async recordVerification(record: VerificationRecord): Promise<void> {
        await service.recordVerification(orchestrationId, record);
      },
      async reserveWorkerAttempt(input): Promise<BudgetDecision> {
        return service.reserveWorkerAttempt(orchestrationId, input);
      },
      async requestContextExpansion(request): Promise<ContextExpansionDecision> {
        return service.requestContextExpansion(orchestrationId, request);
      },
      async markIntegrating(summary: string): Promise<void> {
        await service.markStage(orchestrationId, "integrating", summary);
      },
      async markVerifying(summary: string): Promise<void> {
        await service.markStage(orchestrationId, "verifying", summary);
      },
      async recordWorkspaceDisposition(disposition): Promise<void> {
        await service.recordWorkspaceDisposition(orchestrationId, disposition);
      },
    };
  }

  private async reserveModelCall(
    orchestrationId: string,
    input: ModelCallReservation,
  ): Promise<BudgetDecision> {
    const timestamp = this.now();
    const nowMs = this.clock().getTime();
    const decision = await this.store.mutate((database): BudgetDecision => {
      const stored = database.orchestrations.find((item) => item.id === orchestrationId);
      const state = this.mustFindBudgetState(database, orchestrationId);
      if (!stored) {
        return { allowed: false, reason: "Orchestration not found" };
      }
      const context: BudgetContext = {
        budget: stored.budget,
        usage: stored.usage,
        state,
        pricing: this.pricing,
        nowMs,
      };
      const evaluation = evaluateModelCall(context, input);
      if (!evaluation.allowed) {
        state.exhaustedReason = evaluation.reason;
        this.pushEvent(database, {
          orchestrationId,
          taskId: input.taskId ?? null,
          executionId: input.executionId,
          type: ORCHESTRATION_EVENT_TYPES.budgetDenied,
          actorRole: "control-plane",
          modelId: input.modelId,
          summary: evaluation.reason,
          metadata: { role: input.role, modelCalls: state.modelCalls },
        });
        return { allowed: false, reason: evaluation.reason };
      }
      const reservationId = this.newId();
      state.reservations.push({
        id: reservationId,
        orchestrationId,
        taskId: input.taskId ?? null,
        executionId: input.executionId,
        role: input.role,
        modelId: input.modelId,
        estimatedInputTokens: nonNegative(input.estimatedInputTokens),
        estimatedOutputTokens: nonNegative(input.estimatedOutputTokens),
        status: "open",
        createdAt: timestamp,
        settledAt: null,
      });
      state.modelCalls += 1;
      state.steps += 1;
      this.pushEvent(database, {
        orchestrationId,
        taskId: input.taskId ?? null,
        executionId: input.executionId,
        type: ORCHESTRATION_EVENT_TYPES.budgetReserved,
        actorRole: "control-plane",
        modelId: input.modelId,
        summary:
          "Reserved model call " +
          state.modelCalls +
          " of " +
          stored.budget.maxModelCalls +
          " for role " +
          input.role,
        metadata: {
          role: input.role,
          reservationId,
          estimatedInputTokens: nonNegative(input.estimatedInputTokens),
          estimatedOutputTokens: nonNegative(input.estimatedOutputTokens),
        },
      });
      return { allowed: true, reservationId };
    });

    if (!decision.allowed) {
      await this.markBudgetExhausted(orchestrationId, decision.reason);
    }
    return decision;
  }

  private async commitModelUsage(
    orchestrationId: string,
    reservationId: string,
    actual: TokenUsage,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      const stored = database.orchestrations.find((item) => item.id === orchestrationId);
      const state = database.budgetStates.find(
        (item) => item.orchestrationId === orchestrationId,
      );
      if (!stored || !state) {
        return;
      }
      const reservation = state.reservations.find((item) => item.id === reservationId);
      if (!reservation || reservation.status !== "open") {
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.usageOrphaned,
          actorRole: "control-plane",
          modelId: null,
          summary: "Usage reported for an unknown or settled reservation",
          metadata: { reservationId },
        });
        return;
      }
      const usage = normalizeTokenUsage(actual);
      reservation.status = "committed";
      reservation.settledAt = timestamp;
      stored.usage = applyUsage(
        stored.usage,
        reservation.role,
        reservation.modelId,
        usage,
        this.pricing,
      );
      stored.updatedAt = timestamp;
      this.pushEvent(database, {
        orchestrationId,
        taskId: reservation.taskId,
        executionId: reservation.executionId,
        type: ORCHESTRATION_EVENT_TYPES.usageCommitted,
        actorRole: reservation.role,
        modelId: reservation.modelId,
        summary:
          "Committed usage for role " +
          reservation.role +
          ": " +
          usage.inputTokens +
          " input, " +
          usage.cachedInputTokens +
          " cached, " +
          usage.outputTokens +
          " output tokens",
        metadata: {
          role: reservation.role,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          totalEstimatedUsd: stored.usage.totalEstimatedUsd,
          pricingStatus: stored.usage.pricingStatus,
        },
      });
    });
  }

  private async reserveWorkerAttempt(
    orchestrationId: string,
    input: { taskId: string; executionId: string | null },
  ): Promise<BudgetDecision> {
    const nowMs = this.clock().getTime();
    return this.store.mutate((database): BudgetDecision => {
      const stored = database.orchestrations.find((item) => item.id === orchestrationId);
      const state = this.mustFindBudgetState(database, orchestrationId);
      if (!stored) {
        return { allowed: false, reason: "Orchestration not found" };
      }
      const evaluation = evaluateWorkerAttempt(
        { budget: stored.budget, usage: stored.usage, state, pricing: this.pricing, nowMs },
        input.taskId,
      );
      if (!evaluation.allowed) {
        this.pushEvent(database, {
          orchestrationId,
          taskId: input.taskId,
          executionId: input.executionId,
          type: ORCHESTRATION_EVENT_TYPES.workerAttemptDenied,
          actorRole: "control-plane",
          modelId: null,
          summary: evaluation.reason,
          metadata: {},
        });
        return { allowed: false, reason: evaluation.reason };
      }
      const attempts = (state.workerAttemptsByTask[input.taskId] ?? 0) + 1;
      state.workerAttemptsByTask[input.taskId] = attempts;
      state.steps += 1;
      const reservationId = this.newId();
      this.pushEvent(database, {
        orchestrationId,
        taskId: input.taskId,
        executionId: input.executionId,
        type: ORCHESTRATION_EVENT_TYPES.workerAttemptReserved,
        actorRole: "control-plane",
        modelId: null,
        summary:
          "Worker attempt " +
          attempts +
          " of " +
          stored.budget.maxWorkerAttempts +
          " allowed for task " +
          input.taskId,
        metadata: { attempt: attempts, reservationId },
      });
      return { allowed: true, reservationId };
    });
  }

  private async requestContextExpansion(
    orchestrationId: string,
    request: ContextExpansionRequest,
  ): Promise<ContextExpansionDecision> {
    const nowMs = this.clock().getTime();
    return this.store.mutate((database): ContextExpansionDecision => {
      const stored = database.orchestrations.find((item) => item.id === orchestrationId);
      const state = this.mustFindBudgetState(database, orchestrationId);
      if (!stored) {
        return { allowed: false, reason: "Orchestration not found" };
      }
      const evaluation = evaluateContextExpansion(
        { budget: stored.budget, usage: stored.usage, state, pricing: this.pricing, nowMs },
        request.taskId,
      );
      if (!evaluation.allowed) {
        this.pushEvent(database, {
          orchestrationId,
          taskId: request.taskId,
          executionId: request.executionId,
          type: ORCHESTRATION_EVENT_TYPES.contextExpansionDenied,
          actorRole: "control-plane",
          modelId: null,
          summary: evaluation.reason,
          metadata: { requestedPath: toText(request.requestedPath, 500) },
        });
        return { allowed: false, reason: evaluation.reason };
      }
      const expansions = (state.contextExpansionsByTask[request.taskId] ?? 0) + 1;
      state.contextExpansionsByTask[request.taskId] = expansions;
      state.steps += 1;
      const expansionId = this.newId();
      this.pushEvent(database, {
        orchestrationId,
        taskId: request.taskId,
        executionId: request.executionId,
        type: ORCHESTRATION_EVENT_TYPES.contextExpansionGranted,
        actorRole: "control-plane",
        modelId: null,
        summary:
          "Context expansion " +
          expansions +
          " of " +
          stored.budget.maxContextExpansionsPerTask +
          " granted: " +
          toText(request.reason, 300),
        metadata: {
          expansionId,
          expansion: expansions,
          requestedPath: toText(request.requestedPath, 500),
        },
      });
      return { allowed: true, expansionId };
    });
  }

  private async recordEventOnly(
    orchestrationId: string,
    event: EventInput,
  ): Promise<void> {
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      this.pushEvent(database, { ...event, orchestrationId });
    });
  }

  private async upsertTask(orchestrationId: string, task: OrchestrationTask): Promise<void> {
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const normalized = this.normalizeTask(task, orchestrationId);
      const index = database.tasks.findIndex((item) => item.id === normalized.id);
      if (index >= 0) {
        database.tasks[index] = normalized;
      } else {
        database.tasks.push(normalized);
      }
      this.pushEvent(database, {
        orchestrationId,
        taskId: normalized.id,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.taskUpserted,
        actorRole: "control-plane",
        modelId: null,
        summary: "Task " + normalized.title + " is " + normalized.status,
        metadata: {
          status: normalized.status,
          attemptCount: normalized.attemptCount,
          applicationMapVersion: normalized.applicationMapVersion,
        },
      });
    });
  }

  private async recordApplicationMap(
    orchestrationId: string,
    map: ApplicationMapSummary,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const normalized = this.normalizeApplicationMap(map, orchestrationId, timestamp);
      const index = database.applicationMaps.findIndex(
        (item) =>
          item.orchestrationId === orchestrationId && item.version === normalized.version,
      );
      if (index >= 0) {
        database.applicationMaps[index] = normalized;
      } else {
        database.applicationMaps.push(normalized);
      }
      this.pushEvent(database, {
        orchestrationId,
        taskId: null,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.applicationMapRecorded,
        actorRole: "planner",
        modelId: null,
        summary:
          "Application map v" +
          normalized.version +
          " recorded over " +
          normalized.fileCount +
          " files",
        metadata: {
          version: normalized.version,
          fileCount: normalized.fileCount,
          repositoryHash: normalized.repositoryHash,
        },
      });
    });
  }

  private async recordContextPacket(
    orchestrationId: string,
    packet: ContextPacketSummary,
  ): Promise<void> {
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const normalized: ContextPacketSummary = {
        taskId: toText(packet.taskId, 200),
        applicationMapVersion: nonNegative(packet.applicationMapVersion),
        contractVersion: nonNegative(packet.contractVersion),
        sourceFiles: (Array.isArray(packet.sourceFiles) ? packet.sourceFiles : [])
          .slice(0, 200)
          .map((file) => ({
            path: toText(file?.path, 1_000),
            sha256: toText(file?.sha256, 128),
            bytes: nonNegative(file?.bytes),
          })),
        relevantInterfaces: toStringArray(packet.relevantInterfaces),
        artifactVersions: this.normalizeVersionMap(packet.artifactVersions),
        estimatedTokens: nonNegative(packet.estimatedTokens),
      };
      const index = database.contextPackets.findIndex(
        (item) =>
          item.taskId === normalized.taskId &&
          item.applicationMapVersion === normalized.applicationMapVersion &&
          item.contractVersion === normalized.contractVersion,
      );
      if (index >= 0) {
        database.contextPackets[index] = normalized;
      } else {
        database.contextPackets.push(normalized);
      }
      this.pushEvent(database, {
        orchestrationId,
        taskId: normalized.taskId,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.contextPacketRecorded,
        actorRole: "control-plane",
        modelId: null,
        summary:
          "Context packet with " +
          normalized.sourceFiles.length +
          " files, about " +
          normalized.estimatedTokens +
          " tokens",
        metadata: {
          fileCount: normalized.sourceFiles.length,
          estimatedTokens: normalized.estimatedTokens,
          applicationMapVersion: normalized.applicationMapVersion,
        },
      });
    });
  }

  private async recordAttempt(
    orchestrationId: string,
    attempt: WorkerAttempt,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const state = this.mustFindBudgetState(database, orchestrationId);
      const normalized: WorkerAttempt = {
        id: toText(attempt.id, 200) || this.newId(),
        orchestrationId,
        taskId: toText(attempt.taskId, 200),
        number: nonNegative(attempt.number),
        executionId: toText(attempt.executionId, 200),
        modelId: toText(attempt.modelId, 200),
        contextFileHashes: toStringArray(attempt.contextFileHashes, 200, 128),
        changedFiles: toStringArray(attempt.changedFiles, 200, 1_000),
        status: attempt.status,
        usage: normalizeTokenUsage(attempt.usage),
        errorSummary: attempt.errorSummary === null ? null : toText(attempt.errorSummary, 2_000),
        createdAt: toText(attempt.createdAt, 64) || timestamp,
        completedAt: attempt.completedAt === null ? null : toText(attempt.completedAt, 64),
      };
      const index = database.attempts.findIndex((item) => item.id === normalized.id);
      if (index >= 0) {
        database.attempts[index] = normalized;
      } else {
        database.attempts.push(normalized);
        state.steps += 1;
      }
      this.pushEvent(database, {
        orchestrationId,
        taskId: normalized.taskId,
        executionId: normalized.executionId,
        type: ORCHESTRATION_EVENT_TYPES.attemptRecorded,
        actorRole: "worker",
        modelId: normalized.modelId,
        summary:
          "Worker attempt " + normalized.number + " is " + normalized.status,
        metadata: {
          attempt: normalized.number,
          status: normalized.status,
          changedFiles: normalized.changedFiles.length,
        },
      });
    });
  }

  private async publishArtifact(
    orchestrationId: string,
    artifact: SharedArtifact,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const state = this.mustFindBudgetState(database, orchestrationId);
      const normalized: SharedArtifact = {
        id: toText(artifact.id, 200) || this.newId(),
        orchestrationId,
        producerTaskId: toText(artifact.producerTaskId, 200),
        kind: artifact.kind,
        name: toText(artifact.name, 200),
        version: nonNegative(artifact.version),
        payload: toText(artifact.payload, 8_000),
        createdAt: toText(artifact.createdAt, 64) || timestamp,
      };
      const index = database.artifacts.findIndex((item) => item.id === normalized.id);
      if (index >= 0) {
        database.artifacts[index] = normalized;
      } else {
        database.artifacts.push(normalized);
        state.steps += 1;
      }
      this.pushEvent(database, {
        orchestrationId,
        taskId: normalized.producerTaskId,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.artifactPublished,
        actorRole: "worker",
        modelId: null,
        summary:
          "Artifact " + normalized.name + " published at version " + normalized.version,
        metadata: {
          artifactId: normalized.id,
          name: normalized.name,
          version: normalized.version,
          kind: normalized.kind,
        },
      });

      // Dependency-drift detection. Task 2's engine owns refreshing the
      // affected work; the control plane records who is affected.
      const staleTaskIds = database.tasks
        .filter(
          (task) =>
            task.orchestrationId === orchestrationId &&
            task.id !== normalized.producerTaskId &&
            typeof task.observedArtifactVersions[normalized.name] === "number" &&
            (task.observedArtifactVersions[normalized.name] ?? 0) < normalized.version,
        )
        .map((task) => task.id);
      if (staleTaskIds.length > 0) {
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type: ORCHESTRATION_EVENT_TYPES.artifactDependencyStale,
          actorRole: "control-plane",
          modelId: null,
          summary:
            staleTaskIds.length +
            " task(s) observe a stale version of artifact " +
            normalized.name,
          metadata: {
            name: normalized.name,
            version: normalized.version,
            staleTaskIds: staleTaskIds.join(","),
          },
        });
      }
    });
  }

  private async recordVerification(
    orchestrationId: string,
    record: VerificationRecord,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const state = this.mustFindBudgetState(database, orchestrationId);
      const normalized: VerificationRecord = {
        id: toText(record.id, 200) || this.newId(),
        orchestrationId,
        taskId: record.taskId === null ? null : toText(record.taskId, 200),
        scope: record.scope,
        commandOrCheck: toText(record.commandOrCheck, 500),
        status: record.status,
        outputSummary: toText(record.outputSummary, 4_000),
        startedAt: toText(record.startedAt, 64) || timestamp,
        completedAt: toText(record.completedAt, 64) || timestamp,
      };
      const index = database.verifications.findIndex((item) => item.id === normalized.id);
      if (index >= 0) {
        database.verifications[index] = normalized;
      } else {
        database.verifications.push(normalized);
        state.steps += 1;
      }
      this.pushEvent(database, {
        orchestrationId,
        taskId: normalized.taskId,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.verificationRecorded,
        actorRole: "verifier",
        modelId: null,
        summary:
          normalized.scope + " check " + normalized.commandOrCheck + " " + normalized.status,
        metadata: { scope: normalized.scope, status: normalized.status },
      });
    });
  }

  private async recordWorkspaceDisposition(
    orchestrationId: string,
    disposition: Omit<WorkspaceDisposition, "orchestrationId" | "recordedAt">,
  ): Promise<void> {
    const timestamp = this.now();
    await this.store.mutate((database) => {
      if (!database.orchestrations.some((item) => item.id === orchestrationId)) {
        return;
      }
      const normalized: WorkspaceDisposition = {
        orchestrationId,
        taskId: disposition.taskId === null ? null : toText(disposition.taskId, 200),
        policy: disposition.policy,
        location: disposition.location === null ? null : toText(disposition.location, 1_000),
        reason: toText(disposition.reason, 1_000),
        recordedAt: timestamp,
      };
      database.workspaceDispositions.push(normalized);
      this.pushEvent(database, {
        orchestrationId,
        taskId: normalized.taskId,
        executionId: null,
        type: ORCHESTRATION_EVENT_TYPES.workspaceDisposition,
        actorRole: "control-plane",
        modelId: null,
        summary: "Temporary worker workspace " + normalized.policy + ": " + normalized.reason,
        metadata: { policy: normalized.policy },
      });
    });
  }

  private async markStage(
    orchestrationId: string,
    stage: "integrating" | "verifying",
    summary: string,
  ): Promise<void> {
    const current = this.store
      .snapshot()
      .orchestrations.find((item) => item.id === orchestrationId);
    if (!current || current.status === stage || !canTransition(current.status, stage)) {
      return;
    }
    await this.transition(orchestrationId, stage, {
      summary,
      actorRole: "control-plane",
      metadata: {},
      beforeStatusEvent: (database) => {
        this.pushEvent(database, {
          orchestrationId,
          taskId: null,
          executionId: null,
          type:
            stage === "integrating"
              ? ORCHESTRATION_EVENT_TYPES.integrationStarted
              : ORCHESTRATION_EVENT_TYPES.verificationStarted,
          actorRole: stage === "integrating" ? "integrator" : "verifier",
          modelId: null,
          summary,
          metadata: {},
        });
      },
    });
  }

  // ----------------------------------------------------------------- helpers

  private now(): string {
    return this.clock().toISOString();
  }

  private async requireAgent(agentId: string): Promise<AgentAccessSummary> {
    const agent = await this.agents.getAgent(agentId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  private requireOrchestration(
    orchestrationId: string,
    snapshot: OrchestrationDatabase = this.store.snapshot(),
  ): Orchestration {
    const orchestration = snapshot.orchestrations.find(
      (item) => item.id === orchestrationId,
    );
    if (!orchestration) {
      throw new HttpError(404, "Orchestration not found");
    }
    return orchestration;
  }

  private mustFind(
    database: OrchestrationDatabase,
    orchestrationId: string,
  ): Orchestration {
    const orchestration = database.orchestrations.find(
      (item) => item.id === orchestrationId,
    );
    if (!orchestration) {
      throw new HttpError(404, "Orchestration not found");
    }
    return orchestration;
  }

  private mustFindBudgetState(
    database: OrchestrationDatabase,
    orchestrationId: string,
  ): BudgetState {
    let state = database.budgetStates.find(
      (item) => item.orchestrationId === orchestrationId,
    );
    if (!state) {
      state = createBudgetState(orchestrationId, this.now());
      database.budgetStates.push(state);
    }
    return state;
  }

  private isResolved(orchestrationId: string): boolean {
    const current = this.store
      .snapshot()
      .orchestrations.find((item) => item.id === orchestrationId);
    return !current || isTerminalStatus(current.status);
  }

  private nextDraftRevision(
    database: OrchestrationDatabase,
    orchestrationId: string,
  ): number {
    return (
      database.intentDrafts.filter((item) => item.orchestrationId === orchestrationId)
        .length + 1
    );
  }

  private pushEvent(database: OrchestrationDatabase, event: EventInput): void {
    const safe = redactRecord(event);
    database.events.push({
      ...safe,
      id: this.newId(),
      createdAt: this.now(),
    });
    const forOrchestration = database.events.filter(
      (item) => item.orchestrationId === event.orchestrationId,
    );
    if (forOrchestration.length > MAX_EVENTS_PER_ORCHESTRATION) {
      const dropCount = forOrchestration.length - MAX_EVENTS_PER_ORCHESTRATION;
      const dropIds = new Set(forOrchestration.slice(0, dropCount).map((item) => item.id));
      database.events = database.events.filter((item) => !dropIds.has(item.id));
    }
    if (database.events.length > MAX_TOTAL_EVENTS) {
      database.events = database.events.slice(database.events.length - MAX_TOTAL_EVENTS);
    }
  }

  private pushStatusEvent(
    database: OrchestrationDatabase,
    orchestrationId: string,
    from: OrchestrationStatus,
    to: OrchestrationStatus,
    metadata: EventMetadata = {},
  ): void {
    this.pushEvent(database, {
      orchestrationId,
      taskId: null,
      executionId: null,
      type: ORCHESTRATION_EVENT_TYPES.statusChanged,
      actorRole: "control-plane",
      modelId: null,
      summary: "Status " + from + " -> " + to,
      metadata: { ...metadata, from, to },
    });
  }

  /**
   * The single write path for `orchestration.status`. Every change is checked
   * against the state machine inside the serialized store mutation.
   */
  private async transition(
    orchestrationId: string,
    to: OrchestrationStatus,
    options: {
      summary: string;
      actorRole: OrchestrationEvent["actorRole"];
      metadata: EventMetadata;
      error?: string | null;
      finalOutput?: string | null;
      beforeStatusEvent?: (database: OrchestrationDatabase) => void;
    },
  ): Promise<Orchestration> {
    return this.store.mutate((database) => {
      const stored = this.mustFind(database, orchestrationId);
      const from = stored.status;
      assertTransition(from, to);
      const timestamp = this.now();
      stored.status = to;
      stored.updatedAt = timestamp;
      if (options.error !== undefined) {
        stored.error = options.error;
      }
      if (options.finalOutput !== undefined) {
        stored.finalOutput = options.finalOutput;
      }
      if (isTerminalStatus(to)) {
        stored.completedAt = timestamp;
      }
      options.beforeStatusEvent?.(database);
      this.pushStatusEvent(database, orchestrationId, from, to, {
        ...options.metadata,
        summary: options.summary,
        actorRole: options.actorRole,
      });
      return redactForResponse(structuredClone(stored));
    });
  }

  /** Marks in-flight child records resolved when an orchestration stops. */
  private reconcileChildren(
    database: OrchestrationDatabase,
    orchestrationId: string,
    timestamp: string,
  ): void {
    for (const task of database.tasks) {
      if (task.orchestrationId !== orchestrationId) {
        continue;
      }
      if (["ready", "preflight", "running", "verifying", "blocked", "stale"].includes(task.status)) {
        task.status = "cancelled";
      }
    }
    for (const attempt of database.attempts) {
      if (attempt.orchestrationId === orchestrationId && attempt.status === "running") {
        attempt.status = "cancelled";
        attempt.completedAt = timestamp;
      }
    }
    const state = database.budgetStates.find(
      (item) => item.orchestrationId === orchestrationId,
    );
    if (state) {
      for (const reservation of state.reservations) {
        if (reservation.status === "open") {
          reservation.status = "released";
          reservation.settledAt = timestamp;
        }
      }
    }
  }

  /** Aborts the signal, asks the driver to cancel, waits for the phase to settle. */
  private async releaseChildWork(orchestrationId: string, reason: string): Promise<void> {
    this.controllers.get(orchestrationId)?.abort();
    let driverCancelled = false;
    try {
      driverCancelled = await this.driver.cancel(orchestrationId);
    } catch (error) {
      this.logger?.error("Driver cancel failed for " + orchestrationId, error);
    }
    await this.whenSettled(orchestrationId);
    await this.recordEventOnly(orchestrationId, {
      orchestrationId,
      taskId: null,
      executionId: null,
      type: ORCHESTRATION_EVENT_TYPES.cancellationReconciled,
      actorRole: "control-plane",
      modelId: null,
      summary: "Child work released: " + reason,
      metadata: { driverCancelled },
    });
  }

  private startPhase(
    orchestrationId: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    this.controllers.set(orchestrationId, controller);
    let work!: Promise<void>;
    work = run(controller.signal)
      .catch((error) => {
        this.logger?.error("Orchestration phase failed for " + orchestrationId, error);
      })
      .finally(() => {
        if (this.activeWork.get(orchestrationId) === work) {
          this.activeWork.delete(orchestrationId);
        }
        if (this.controllers.get(orchestrationId) === controller) {
          this.controllers.delete(orchestrationId);
        }
      });
    this.activeWork.set(orchestrationId, work);
  }

  private composeRevisionPrompt(orchestration: Orchestration, feedback: string): string {
    return (
      orchestration.prompt +
      "\n\nUser revision request:\n" +
      feedback
    ).slice(0, MAX_PROMPT_LENGTH);
  }

  private normalizeEstimate(raw: CostEstimate): CostEstimate {
    const priced =
      this.pricing.isConfigured &&
      raw?.pricingStatus === "configured" &&
      typeof raw.estimatedUsdLow === "number" &&
      typeof raw.estimatedUsdHigh === "number";
    return {
      inputTokenLow: nonNegative(raw?.inputTokenLow),
      inputTokenHigh: nonNegative(raw?.inputTokenHigh),
      outputTokenLow: nonNegative(raw?.outputTokenLow),
      outputTokenHigh: nonNegative(raw?.outputTokenHigh),
      estimatedUsdLow: priced ? nonNegative(raw.estimatedUsdLow) : null,
      estimatedUsdHigh: priced ? nonNegative(raw.estimatedUsdHigh) : null,
      pricingStatus: priced ? "configured" : "unknown",
      assumptions: toStringArray(raw?.assumptions, 50),
    };
  }

  private normalizeCriteria(criteria: ContractCriterion[]): ContractCriterion[] {
    return criteria.slice(0, 200).map((criterion, index) => ({
      id: toText(criterion.id, 100) || "c" + (index + 1),
      kind: criterion.kind,
      description: toText(criterion.description, 2_000),
      verification: criterion.verification,
    }));
  }

  /**
   * Derives typed acceptance criteria from the confirmed intent. Protected
   * implementation of a check is never stored here - only its description.
   */
  private deriveCriteria(draft: IntentDraft): ContractCriterion[] {
    const criteria: ContractCriterion[] = [];
    const add = (
      kind: ContractCriterion["kind"],
      description: string,
      verification: ContractCriterion["verification"],
    ): void => {
      criteria.push({
        id: "c" + (criteria.length + 1),
        kind,
        description: description.slice(0, 2_000),
        verification,
      });
    };
    for (const requirement of draft.requirements) {
      add("functional", requirement, "protected-test");
    }
    for (const decision of draft.architectureDecisions) {
      add("architectural", decision, "static-check");
    }
    for (const nonGoal of draft.nonGoals) {
      add("scope", "Out of scope: " + nonGoal, "static-check");
    }
    for (const expectation of draft.manualExpectations) {
      add("manual", expectation, "manual");
    }
    add(
      "runtime",
      "The integrated workspace passes the project's existing regression and type checks without weakening them.",
      "protected-test",
    );
    return criteria;
  }

  private normalizeVersionMap(value: unknown): Record<string, number> {
    const output: Record<string, number> = {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw === "number" && Number.isFinite(raw)) {
          output[key.slice(0, 200)] = raw;
        }
      }
    }
    return output;
  }

  private normalizeTask(task: OrchestrationTask, orchestrationId: string): OrchestrationTask {
    return {
      id: toText(task.id, 200) || this.newId(),
      orchestrationId,
      title: toText(task.title, 300),
      objective: toText(task.objective, 2_000),
      status: task.status,
      dependsOn: toStringArray(task.dependsOn, 100, 200),
      allowedPaths: toStringArray(task.allowedPaths, 200, 1_000),
      acceptanceCriterionIds: toStringArray(task.acceptanceCriterionIds, 200, 100),
      requiredArtifactIds: toStringArray(task.requiredArtifactIds, 200, 200),
      observedArtifactVersions: this.normalizeVersionMap(task.observedArtifactVersions),
      applicationMapVersion: nonNegative(task.applicationMapVersion),
      attemptCount: nonNegative(task.attemptCount),
    };
  }

  private normalizeApplicationMap(
    map: ApplicationMapSummary,
    orchestrationId: string,
    timestamp: string,
  ): ApplicationMapSummary {
    return {
      orchestrationId,
      version: nonNegative(map?.version) || 1,
      repositoryHash: toText(map?.repositoryHash, 128),
      summary: toText(map?.summary, 4_000),
      fileCount: nonNegative(map?.fileCount),
      createdAt: toText(map?.createdAt, 64) || timestamp,
    };
  }
}

/**
 * Adapter Final Assembly injects into `AgentService` so direct Playground runs
 * and orchestrated execution cannot write one Agent workspace concurrently.
 */
export function createAgentExecutionCoordinator(
  service: OrchestrationControlService,
): AgentExecutionCoordinator {
  return {
    assertAgentAvailableForDirect: (agentId) =>
      service.assertAgentAvailableForDirect(agentId),
    hasActiveOrchestration: (agentId) => service.hasActiveOrchestration(agentId),
    cancelForAgent: (agentId) => service.cancelForAgent(agentId),
  };
}
