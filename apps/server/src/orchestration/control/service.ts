import { randomUUID } from "node:crypto";
import type {
  ApplicationMapSummary,
  BudgetDecision,
  BudgetPolicy,
  ContextPacketSummary,
  ContractAmendment,
  ContractCriterion,
  ExecutionContract,
  IntentDraft,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  PlanResult,
  RequestedExecutionMode,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import {
  commitUsageToDatabase,
  decideReservation,
  estimateExceedsBudget,
  type ModelPricing,
} from "./budget-ledger.js";
import {
  buildReadModel,
  OrchestrationNotFoundError,
  type OrchestrationReadModel,
} from "./read-model.js";
import { redactClone, redactString } from "./redaction.js";
import {
  assertTransition,
  isTerminalStatus,
  OrchestrationConflictError,
} from "./state-machine.js";
import {
  OrchestrationStore,
  type OrchestrationDatabase,
} from "./store.js";

export interface AgentAccessRecord {
  id: string;
  status: "ready" | "busy" | "stopped" | "error";
  workspacePath: string;
}

export interface AgentAccessPort {
  getAgent(agentId: string): AgentAccessRecord | null | Promise<AgentAccessRecord | null>;
}

export interface AgentExecutionCoordinator {
  assertAgentAvailableForDirect(agentId: string): Promise<void>;
  hasActiveOrchestration(agentId: string): boolean;
  cancelForAgent(agentId: string): Promise<boolean>;
}

export interface OrchestrationServiceOptions {
  store: OrchestrationStore;
  driver: OrchestrationExecutionDriver;
  agentAccess: AgentAccessPort;
  defaultBudget?: Partial<BudgetPolicy>;
  pricing?: readonly ModelPricing[];
  clock?: () => Date;
  id?: () => string;
  cleanupPolicy?: "clean" | "archive" | "retain";
}

export interface CreateOrchestrationInput {
  prompt: string;
  requestedMode: RequestedExecutionMode;
  budget?: Partial<BudgetPolicy>;
}

function clarificationPrompt(value: string): string {
  try {
    const parsed = JSON.parse(value) as { prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : value;
  } catch {
    return value;
  }
}

function clarificationReconciliationPrompt(
  originalPrompt: string,
  draft: IntentDraft,
  answers: readonly string[],
): string {
  const resolutions = draft.materialQuestions.map((question, index) => ({
    question: clarificationPrompt(question),
    resolution: answers[index] ?? "",
  }));
  const currentIntent = {
    goal: draft.goal,
    requirements: draft.requirements,
    assumptions: draft.assumptions,
    nonGoals: draft.nonGoals,
    architectureDecisions: draft.architectureDecisions,
    manualExpectations: draft.manualExpectations,
  };
  return [
    "Clarification reconciliation pass. Every material question has been answered by the user.",
    "Produce one complete replacement intent; do not merely append the answers to the old draft.",
    "Treat the original request and the clarification resolutions as authoritative.",
    "Update the goal, requirements, assumptions, non-goals, architecture decisions, and manual expectations wherever a resolution has consequences.",
    "Remove stale or conditional statements that the resolutions have decided, including an old non-goal for behavior the user chose to include.",
    "The returned sections must be mutually consistent: requirements must not conflict with non-goals, assumptions must not conflict with requirements or non-goals, and architecture decisions and manual expectations must describe the same resolved scope.",
    "Preserve unaffected decisions, but do not retain duplicate or contradictory statements. Return no material questions because all listed questions are resolved.",
    `Original user request: ${originalPrompt}`,
    `Current intent draft: ${JSON.stringify(currentIntent)}`,
    `Authoritative clarification resolutions: ${JSON.stringify(resolutions)}`,
  ].join("\n");
}

export class OrchestrationSemanticError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "OrchestrationSemanticError";
  }
}

export class OrchestrationInputError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "OrchestrationInputError";
  }
}

export class AgentUnavailableError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 409) {
    super(message);
    this.name = "AgentUnavailableError";
    this.statusCode = statusCode;
  }
}

export class BudgetExhaustedError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

const DEFAULT_BUDGET: BudgetPolicy = {
  maxInputTokens: null,
  maxOutputTokens: null,
  maxEstimatedUsd: null,
  maxModelCalls: 100,
  maxSteps: 250,
  maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 3,
  maxArkApiTurns: 150,
  maxArkApiTurnsPerExecution: 15,
  maxInputTokensPerExecution: 250_000,
};

const MAX_BUDGET: Record<keyof BudgetPolicy, number> = {
  maxInputTokens: 100_000_000,
  maxOutputTokens: 20_000_000,
  maxEstimatedUsd: 100_000,
  maxModelCalls: 10_000,
  maxSteps: 100_000,
  maxWorkerAttempts: 100,
  maxContextExpansionsPerTask: 100,
  maxArkApiTurns: 100_000,
  maxArkApiTurnsPerExecution: 1_000,
  maxInputTokensPerExecution: 10_000_000,
};

const emptyUsage = (pricingConfigured: boolean): Orchestration["usage"] => ({
  byRole: {},
  totalInputTokens: 0,
  totalCachedInputTokens: 0,
  totalOutputTokens: 0,
  totalEstimatedUsd: pricingConfigured ? 0 : null,
  pricingStatus: pricingConfigured ? "configured" : "unknown",
  totalArkApiTurns: 0,
  totalToolCalls: 0,
  totalStreamRetries: 0,
  peakContextTokens: 0,
});

function boundedBudget(
  defaults: BudgetPolicy,
  override: Partial<BudgetPolicy> | undefined,
): BudgetPolicy {
  const result = { ...defaults, ...override };
  for (const [key, value] of Object.entries(result) as Array<
    [keyof BudgetPolicy, number | null]
  >) {
    if (value === null) {
      if (key.startsWith("max") && ["maxInputTokens", "maxOutputTokens", "maxEstimatedUsd"].includes(key)) continue;
      throw new OrchestrationSemanticError(`${key} may not be null`);
    }
    if (!Number.isFinite(value) || value < 0 || value > MAX_BUDGET[key]) {
      throw new OrchestrationSemanticError(`${key} is outside the allowed range`);
    }
    if (key !== "maxEstimatedUsd" && !Number.isSafeInteger(value)) {
      throw new OrchestrationSemanticError(`${key} must be an integer`);
    }
  }
  return result;
}

function findOrchestration(
  database: OrchestrationDatabase,
  orchestrationId: string,
): Orchestration {
  const orchestration = database.orchestrations.find(
    (entry) => entry.id === orchestrationId,
  );
  if (!orchestration) throw new OrchestrationNotFoundError(orchestrationId);
  return orchestration;
}

function upsertById<T extends { id: string }>(collection: T[], value: T): void {
  const index = collection.findIndex((entry) => entry.id === value.id);
  if (index < 0) collection.push(value);
  else collection[index] = value;
}

export class OrchestrationControlService implements OrchestrationSink {
  private readonly store: OrchestrationStore;
  private readonly driver: OrchestrationExecutionDriver;
  private readonly agentAccess: AgentAccessPort;
  private readonly defaultBudget: BudgetPolicy;
  private readonly pricing: readonly ModelPricing[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly cleanupPolicy: "clean" | "archive" | "retain";
  private readonly controllers = new Map<string, AbortController>();
  private readonly background = new Map<string, Promise<void>>();

  constructor(options: OrchestrationServiceOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.agentAccess = options.agentAccess;
    this.defaultBudget = boundedBudget(DEFAULT_BUDGET, options.defaultBudget);
    this.pricing = options.pricing ?? [];
    this.now = options.clock ?? (() => new Date());
    this.newId = options.id ?? randomUUID;
    this.cleanupPolicy = options.cleanupPolicy ?? "archive";
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    const interrupted = new Set([
      "drafting-intent",
      "planning",
      "running",
      "integrating",
      "verifying",
    ]);
    await this.store.mutate((database) => {
      const now = this.now().toISOString();
      for (const orchestration of database.orchestrations) {
        if (!interrupted.has(orchestration.status)) continue;
        orchestration.status = "cancelled";
        orchestration.error = "Cancelled during restart reconciliation";
        orchestration.updatedAt = now;
        orchestration.completedAt = now;
        database.reservations = database.reservations.filter(
          (entry) => entry.orchestrationId !== orchestration.id,
        );
        database.events.push(
          this.makeEvent(orchestration.id, "restart-reconciled", "Interrupted work was cancelled during server restart", {
            previousState: "interrupted",
            cleanupPolicy: this.cleanupPolicy,
          }),
        );
        this.setCleanup(database, orchestration.id, "pending", "Filesystem reconciliation delegated to the execution engine");
      }
    });
  }

  listOrchestrations(agentId: string): Orchestration[] {
    return this.store
      .snapshot()
      .orchestrations.filter((entry) => entry.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getOrchestration(orchestrationId: string): OrchestrationReadModel {
    return buildReadModel(this.store.snapshot(), orchestrationId);
  }

  hasActiveOrchestration(agentId: string): boolean {
    return this.store
      .snapshot()
      .orchestrations.some(
        (entry) => entry.agentId === agentId && !isTerminalStatus(entry.status),
      );
  }

  async assertAgentAvailableForDirect(agentId: string): Promise<void> {
    if (this.hasActiveOrchestration(agentId)) {
      throw new OrchestrationConflictError(
        "An active orchestration already owns this Agent workspace",
      );
    }
  }

  async cancelForAgent(agentId: string): Promise<boolean> {
    const active = this.store
      .snapshot()
      .orchestrations.filter(
        (entry) => entry.agentId === agentId && !isTerminalStatus(entry.status),
      );
    const results = await Promise.all(active.map((entry) => this.cancel(entry.id)));
    return results.some(Boolean);
  }

  coordinator(): AgentExecutionCoordinator {
    return {
      assertAgentAvailableForDirect: (agentId) =>
        this.assertAgentAvailableForDirect(agentId),
      hasActiveOrchestration: (agentId) => this.hasActiveOrchestration(agentId),
      cancelForAgent: (agentId) => this.cancelForAgent(agentId),
    };
  }

  async createOrchestration(
    agentId: string,
    input: CreateOrchestrationInput,
  ): Promise<Orchestration> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
      throw new OrchestrationInputError("Agent ID must be a UUID");
    }
    if (!["auto", "direct", "orchestrated"].includes(input.requestedMode)) {
      throw new OrchestrationInputError("Unknown requested execution mode");
    }
    const agent = await this.requireRunnableAgent(agentId);
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 50_000) {
      throw new OrchestrationSemanticError("Prompt must contain 1 to 50,000 characters");
    }
    const budget = boundedBudget(this.defaultBudget, input.budget);
    const id = this.newId();
    const now = this.now().toISOString();
    const orchestration: Orchestration = {
      id,
      agentId,
      prompt: redactString(prompt, 50_000),
      requestedMode: input.requestedMode,
      selectedMode: null,
      status: "drafting-intent",
      currentIntentDraftId: null,
      activeContractId: null,
      estimate: null,
      budget,
      usage: emptyUsage(this.pricing.length > 0),
      finalOutput: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await this.store.mutate((database) => {
      if (
        database.orchestrations.some(
          (entry) => entry.agentId === agentId && !isTerminalStatus(entry.status),
        )
      ) {
        throw new OrchestrationConflictError(
          "Only one active orchestration is allowed per Agent",
        );
      }
      database.orchestrations.push(orchestration);
      database.events.push(
        this.makeEvent(id, "orchestration-created", "Orchestration created and intent elaboration queued", {
          requestedMode: input.requestedMode,
        }),
      );
      this.setCleanup(database, id, "pending", "No worker temporary state has been created yet");
    });
    this.launch(id, (signal) => this.elaborate(id, agent.workspacePath, 1, signal));
    return redactClone(orchestration);
  }

  async reviseIntent(orchestrationId: string, revision: string): Promise<Orchestration> {
    const feedback = revision.trim();
    if (!feedback || feedback.length > 20_000) {
      throw new OrchestrationSemanticError("Revision must contain 1 to 20,000 characters");
    }
    const model = this.getOrchestration(orchestrationId);
    const agent = await this.requireRunnableAgent(model.orchestration.agentId);
    const nextRevision = model.intentHistory.length + 1;
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, orchestrationId);
      assertTransition(orchestration.status, "drafting-intent");
      orchestration.status = "drafting-intent";
      orchestration.updatedAt = this.now().toISOString();
      database.events.push(
        this.makeEvent(orchestrationId, "intent-revision-requested", "The user requested a new immutable intent revision", {
          revision: nextRevision,
        }),
      );
    });
    this.launch(orchestrationId, (signal) =>
      this.elaborate(
        orchestrationId,
        agent.workspacePath,
        nextRevision,
        signal,
        `${model.orchestration.prompt}\n\nUser revision:\n${feedback}`,
      ),
    );
    return this.getOrchestration(orchestrationId).orchestration;
  }

  async confirm(
    orchestrationId: string,
    criteria?: ContractCriterion[],
    answers: string[] = [],
  ): Promise<ExecutionContract> {
    const model = this.getOrchestration(orchestrationId);
    const agent = await this.requireRunnableAgent(model.orchestration.agentId);
    const draft = model.activeDraft;
    if (!draft) throw new OrchestrationSemanticError("There is no intent draft to confirm");
    const clarificationAnswers = answers.map((answer) => answer.trim()).filter(Boolean);
    if (clarificationAnswers.length < draft.materialQuestions.length) {
      throw new OrchestrationSemanticError(
        `Answer all ${draft.materialQuestions.length} material questions before confirmation`,
      );
    }
    let confirmedDraft = draft;
    let confirmedEstimate = model.orchestration.estimate;
    if (draft.materialQuestions.length) {
      const reconciled = await this.driver.elaborateIntent(
        {
          orchestrationId,
          agentId: model.orchestration.agentId,
          prompt: redactString(
            clarificationReconciliationPrompt(
              model.orchestration.prompt,
              draft,
              clarificationAnswers,
            ),
            50_000,
          ),
          requestedMode: model.orchestration.requestedMode,
          budget: model.orchestration.budget,
          workspacePath: agent.workspacePath,
        },
        this,
        new AbortController().signal,
      );
      if (reconciled.draft.materialQuestions.length) {
        throw new OrchestrationSemanticError(
          "The planner found new unresolved questions while reconciling the clarification answers",
        );
      }
      confirmedDraft = {
        ...redactClone(reconciled.draft),
        id: this.newId(),
        orchestrationId,
        revision: model.intentHistory.length + 1,
        materialQuestions: [],
        createdAt: this.now().toISOString(),
      };
      confirmedEstimate = redactClone(reconciled.estimate);
    }
    if (confirmedEstimate) {
      const budgetConflict = estimateExceedsBudget(
        confirmedEstimate,
        model.orchestration.budget,
      );
      if (budgetConflict) throw new OrchestrationSemanticError(budgetConflict);
    }
    // Criteria supplied before a clarification are stale by definition. Derive
    // every clarified criterion from the same reconciled intent shown in Details.
    const contractCriteria = criteria?.length && !draft.materialQuestions.length
      ? criteria
      : this.deriveCriteria(confirmedDraft);
    this.validateCriteria(contractCriteria);
    const contract: ExecutionContract = {
      id: this.newId(),
      orchestrationId,
      version: model.contractHistory.length + 1,
      intent: structuredClone(confirmedDraft),
      criteria: redactClone(contractCriteria),
      confirmedBy: "user",
      confirmedAt: this.now().toISOString(),
      supersedesContractId: model.activeContract?.id ?? null,
    };
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, orchestrationId);
      assertTransition(orchestration.status, "planning");
      if (database.contracts.some((entry) => entry.id === contract.id)) {
        throw new OrchestrationConflictError("Contract ID already exists");
      }
      if (confirmedDraft.id !== draft.id) {
        database.intentDrafts.push(redactClone(confirmedDraft));
        orchestration.currentIntentDraftId = confirmedDraft.id;
        orchestration.estimate = confirmedEstimate;
        database.events.push(
          this.makeEvent(
            orchestrationId,
            "clarifications-resolved",
            `Planner reconciled ${draft.materialQuestions.length} user clarification${draft.materialQuestions.length === 1 ? "" : "s"} across the complete intent`,
            {
              answerCount: draft.materialQuestions.length,
              intentRevision: confirmedDraft.revision,
              criteriaRegenerated: true,
            },
          ),
        );
      }
      database.contracts.push(contract);
      orchestration.activeContractId = contract.id;
      orchestration.status = "planning";
      orchestration.updatedAt = this.now().toISOString();
      database.events.push(
        this.makeEvent(orchestrationId, "contract-confirmed", `User explicitly confirmed contract v${contract.version}`, {
          contractVersion: contract.version,
        }),
      );
    });
    this.launch(orchestrationId, (signal) =>
      this.plan(orchestrationId, agent.workspacePath, contract, signal),
    );
    return redactClone(contract);
  }

  async start(orchestrationId: string): Promise<Orchestration> {
    const model = this.getOrchestration(orchestrationId);
    const agent = await this.requireRunnableAgent(model.orchestration.agentId);
    if (!model.activeContract || !model.plan) {
      throw new OrchestrationSemanticError("A confirmed contract and plan are required");
    }
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, orchestrationId);
      assertTransition(orchestration.status, "running");
      orchestration.status = "running";
      orchestration.updatedAt = this.now().toISOString();
      database.events.push(
        this.makeEvent(orchestrationId, "execution-started", "User explicitly started execution", {}),
      );
    });
    const plan: PlanResult = {
      selectedMode: model.plan.selectedMode,
      routeReason: model.plan.routeReason,
      tasks: model.tasks,
      applicationMap: model.applicationMaps.find(
        (entry) => entry.version === model.plan!.applicationMapVersion,
      )!,
    };
    this.launch(orchestrationId, (signal) =>
      this.execute(
        orchestrationId,
        agent.workspacePath,
        model.activeContract!,
        plan,
        signal,
      ),
    );
    return this.getOrchestration(orchestrationId).orchestration;
  }

  async cancel(orchestrationId: string): Promise<boolean> {
    const snapshot = this.getOrchestration(orchestrationId).orchestration;
    this.controllers.get(orchestrationId)?.abort();
    const driverCancelled = await this.driver.cancel(orchestrationId);
    if (snapshot.status === "cancelled") return driverCancelled;
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, orchestrationId);
      const now = this.now().toISOString();
      if (!isTerminalStatus(orchestration.status)) {
        assertTransition(orchestration.status, "cancelled");
        orchestration.status = "cancelled";
        orchestration.error = "Cancelled by user";
        orchestration.completedAt = now;
        orchestration.updatedAt = now;
      }
      database.reservations = database.reservations.filter(
        (entry) => entry.orchestrationId !== orchestrationId,
      );
      database.events.push(
        this.makeEvent(orchestrationId, "cancellation", "Cancellation was requested and child work was reconciled", {
          driverCancelled,
          retainedEvidence: true,
          terminalState: orchestration.status,
        }),
      );
      this.setCleanup(database, orchestrationId, "pending", "Execution engine must reconcile task-specific temporary state");
    });
    return true;
  }

  async confirmAmendment(
    orchestrationId: string,
    amendmentId: string,
    response?: string,
  ): Promise<ExecutionContract> {
    const model = this.getOrchestration(orchestrationId);
    const amendment = model.amendments.find((entry) => entry.id === amendmentId);
    if (!amendment || amendment.status !== "pending") {
      throw new OrchestrationSemanticError("Pending amendment not found");
    }
    const agent = await this.requireRunnableAgent(model.orchestration.agentId);
    let proposedIntent = structuredClone(amendment.proposedIntent);
    const recoveryQuestion = proposedIntent.materialQuestions.join("\n").trim();
    const normalizedResponse = response?.trim() ?? "";
    if (recoveryQuestion && !normalizedResponse) {
      throw new OrchestrationSemanticError("A response is required to resume this recovery request");
    }
    let confirmedEstimate = model.orchestration.estimate;
    if (recoveryQuestion) {
      const reconciled = await this.driver.elaborateIntent(
        {
          orchestrationId,
          agentId: model.orchestration.agentId,
          prompt: redactString(
            clarificationReconciliationPrompt(
              model.orchestration.prompt,
              proposedIntent,
              [normalizedResponse],
            ),
            50_000,
          ),
          requestedMode: model.orchestration.requestedMode,
          budget: model.orchestration.budget,
          workspacePath: agent.workspacePath,
        },
        this,
        new AbortController().signal,
      );
      if (reconciled.draft.materialQuestions.length) {
        throw new OrchestrationSemanticError(
          "The supervisor found new unresolved questions while reconciling the recovery response",
        );
      }
      proposedIntent = {
        ...redactClone(reconciled.draft),
        id: amendment.proposedIntent.id,
        orchestrationId,
        revision: amendment.proposedIntent.revision,
        materialQuestions: [],
        createdAt: this.now().toISOString(),
      };
      confirmedEstimate = redactClone(reconciled.estimate);
    }
    if (confirmedEstimate) {
      const budgetConflict = estimateExceedsBudget(
        confirmedEstimate,
        model.orchestration.budget,
      );
      if (budgetConflict) throw new OrchestrationSemanticError(budgetConflict);
    }
    const criteria = recoveryQuestion
      ? this.deriveCriteria(proposedIntent)
      : amendment.proposedCriteria ?? model.activeContract?.criteria ?? [];
    this.validateCriteria(criteria);
    const contract: ExecutionContract = {
      id: this.newId(),
      orchestrationId,
      version: model.contractHistory.length + 1,
      intent: proposedIntent,
      criteria: structuredClone(criteria),
      confirmedBy: "user",
      confirmedAt: this.now().toISOString(),
      supersedesContractId: amendment.baseContractId,
    };
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, orchestrationId);
      assertTransition(orchestration.status, "planning");
      const stored = database.amendments.find((entry) => entry.id === amendmentId)!;
      stored.status = "confirmed";
      stored.decidedAt = this.now().toISOString();
      stored.proposedIntent = structuredClone(proposedIntent);
      const storedDraftIndex = database.intentDrafts.findIndex(
        (entry) => entry.id === proposedIntent.id,
      );
      if (storedDraftIndex >= 0) database.intentDrafts[storedDraftIndex] = structuredClone(proposedIntent);
      database.contracts.push(contract);
      orchestration.activeContractId = contract.id;
      orchestration.currentIntentDraftId = contract.intent.id;
      orchestration.status = "planning";
      orchestration.estimate = confirmedEstimate;
      orchestration.updatedAt = this.now().toISOString();
      database.events.push(
        this.makeEvent(orchestrationId, "amendment-confirmed", `User confirmed material amendment as contract v${contract.version}`, {
          amendmentId,
          contractVersion: contract.version,
          responseProvided: Boolean(normalizedResponse),
          criteriaRegenerated: Boolean(recoveryQuestion),
        }),
      );
    });
    this.launch(orchestrationId, (signal) =>
      this.plan(orchestrationId, agent.workspacePath, contract, signal),
    );
    return contract;
  }

  async rejectAmendment(orchestrationId: string, amendmentId: string): Promise<void> {
    await this.store.mutate((database) => {
      findOrchestration(database, orchestrationId);
      const amendment = database.amendments.find(
        (entry) => entry.id === amendmentId && entry.orchestrationId === orchestrationId,
      );
      if (!amendment || amendment.status !== "pending") {
        throw new OrchestrationSemanticError("Pending amendment not found");
      }
      amendment.status = "rejected";
      amendment.decidedAt = this.now().toISOString();
      database.events.push(
        this.makeEvent(orchestrationId, "amendment-rejected", "User rejected the material amendment; no contract was weakened", {
          amendmentId,
        }),
      );
    });
  }

  async waitForIdle(orchestrationId: string): Promise<void> {
    await this.background.get(orchestrationId);
  }

  async reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision> {
    return this.store.mutate((database) => {
      const orchestration = findOrchestration(database, input.orchestrationId);
      const { decision, estimatedUsd } = decideReservation(
        orchestration,
        database.reservations,
        input,
        this.pricing,
      );
      if (!decision.allowed) {
        this.markBudgetExhausted(orchestration, decision.reason);
        database.events.push(
          this.makeEvent(input.orchestrationId, "budget-denied", decision.reason, {
            role: input.role,
            modelId: input.modelId,
          }, input.taskId, input.executionId, input.role, input.modelId),
        );
        return decision;
      }
      const reservationId = this.newId();
      database.reservations.push({
        ...redactClone(input),
        id: reservationId,
        estimatedUsd,
        createdAt: this.now().toISOString(),
      });
      database.events.push(
        this.makeEvent(input.orchestrationId, "budget-reserved", "Conservative model-call budget reserved", {
          reservationId,
          estimatedInputTokens: input.estimatedInputTokens,
          estimatedOutputTokens: input.estimatedOutputTokens,
          estimatedUsd,
        }, input.taskId, input.executionId, input.role, input.modelId),
      );
      return { allowed: true, reservationId };
    });
  }

  async commitModelUsage(reservationId: string, actual: TokenUsage): Promise<void> {
    await this.store.mutate((database) => {
      const reservation = database.reservations.find((entry) => entry.id === reservationId);
      if (!reservation) throw new OrchestrationSemanticError("Unknown model-call reservation");
      commitUsageToDatabase(database, reservationId, actual, this.pricing);
      const orchestration = findOrchestration(database, reservation.orchestrationId);
      const budgetReason =
        orchestration.budget.maxInputTokens !== null &&
        orchestration.usage.totalInputTokens > orchestration.budget.maxInputTokens
          ? "Actual input-token usage exceeded the hard budget"
          : orchestration.budget.maxArkApiTurns !== undefined &&
              (orchestration.usage.totalArkApiTurns ?? 0) > orchestration.budget.maxArkApiTurns
            ? "Actual Ark-turn usage exceeded the hard budget"
          : orchestration.budget.maxOutputTokens !== null && orchestration.usage.totalOutputTokens > orchestration.budget.maxOutputTokens
            ? "Actual output-token usage exceeded the hard budget"
            : orchestration.budget.maxEstimatedUsd !== null &&
                orchestration.usage.totalEstimatedUsd !== null &&
                orchestration.usage.totalEstimatedUsd > orchestration.budget.maxEstimatedUsd
              ? "Actual estimated cost exceeded the hard budget"
              : null;
      if (budgetReason) this.markBudgetExhausted(orchestration, budgetReason);
      database.events.push(
        this.makeEvent(reservation.orchestrationId, "usage-committed", "Actual model usage committed to the role ledger", {
          role: reservation.role,
          modelId: reservation.modelId,
          inputTokens: actual.inputTokens,
          cachedInputTokens: actual.cachedInputTokens,
          outputTokens: actual.outputTokens,
          arkApiTurns: actual.arkApiTurns ?? 0,
          toolCalls: actual.toolCalls ?? 0,
          streamRetries: actual.streamRetries ?? 0,
          peakContextTokens: actual.peakContextTokens ?? 0,
        }, reservation.taskId, reservation.executionId, reservation.role, reservation.modelId),
      );
    });
  }

  async recordEvent(
    event: Omit<OrchestrationEvent, "id" | "createdAt">,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, event.orchestrationId);
      const stepEvents = database.events.filter(
        (entry) =>
          entry.orchestrationId === event.orchestrationId &&
          (entry.type === "step" || entry.type.endsWith("-step")),
      ).length;
      if (
        (event.type === "step" || event.type.endsWith("-step")) &&
        stepEvents >= orchestration.budget.maxSteps
      ) {
        this.markBudgetExhausted(orchestration, "Step budget exhausted");
        database.events.push(
          this.makeEvent(event.orchestrationId, "budget-denied", "Step budget exhausted", {}),
        );
        throw new BudgetExhaustedError("Step budget exhausted");
      }
      database.events.push({
        ...redactClone(event),
        id: this.newId(),
        summary: redactString(event.summary),
        createdAt: this.now().toISOString(),
      });
    });
  }

  async upsertTask(task: OrchestrationTask): Promise<void> {
    await this.store.mutate((database) => {
      findOrchestration(database, task.orchestrationId);
      upsertById(database.tasks, redactClone(task));
    });
  }

  async recordApplicationMap(map: ApplicationMapSummary): Promise<void> {
    await this.store.mutate((database) => {
      findOrchestration(database, map.orchestrationId);
      const index = database.applicationMaps.findIndex(
        (entry) => entry.orchestrationId === map.orchestrationId && entry.version === map.version,
      );
      if (index < 0) database.applicationMaps.push(redactClone(map));
      else database.applicationMaps[index] = redactClone(map);
    });
  }

  async recordContextPacket(packet: ContextPacketSummary): Promise<void> {
    await this.store.mutate((database) => {
      const task = database.tasks.find((entry) => entry.id === packet.taskId);
      if (!task) throw new OrchestrationSemanticError("Context packet references an unknown task");
      const expansions = database.events.filter(
        (entry) => entry.taskId === packet.taskId && entry.type === "context-expansion",
      ).length;
      const orchestration = findOrchestration(database, task.orchestrationId);
      if (expansions > orchestration.budget.maxContextExpansionsPerTask) {
        this.markBudgetExhausted(orchestration, "Context-expansion budget exhausted");
        throw new BudgetExhaustedError("Context-expansion budget exhausted");
      }
      database.contextPackets.push(redactClone(packet));
    });
  }

  async recordAttempt(attempt: WorkerAttempt): Promise<void> {
    await this.store.mutate((database) => {
      const orchestration = findOrchestration(database, attempt.orchestrationId);
      if (attempt.number > orchestration.budget.maxWorkerAttempts) {
        this.markBudgetExhausted(orchestration, "Worker-attempt budget exhausted");
        database.events.push(
          this.makeEvent(attempt.orchestrationId, "budget-denied", "Worker-attempt budget exhausted", {
            attempt: attempt.number,
          }, attempt.taskId, attempt.executionId, "worker", attempt.modelId),
        );
        throw new BudgetExhaustedError("Worker-attempt budget exhausted");
      }
      upsertById(database.attempts, redactClone(attempt));
    });
  }

  async publishArtifact(artifact: SharedArtifact): Promise<void> {
    if (artifact.payload.length > 8_000) {
      throw new OrchestrationSemanticError("Artifact payload exceeds the safe summary limit");
    }
    if (/protected evaluator source|-----BEGIN .*PRIVATE KEY-----/i.test(artifact.payload)) {
      throw new OrchestrationSemanticError("Artifact payload contains protected content");
    }
    await this.store.mutate((database) => {
      findOrchestration(database, artifact.orchestrationId);
      const conflicting = database.artifacts.find(
        (entry) =>
          entry.orchestrationId === artifact.orchestrationId &&
          entry.name === artifact.name &&
          entry.version === artifact.version &&
          entry.id !== artifact.id,
      );
      if (conflicting) throw new OrchestrationConflictError("Artifact version already exists");
      const existing = database.artifacts.findIndex(
        (entry) => entry.id === artifact.id && entry.version === artifact.version,
      );
      if (existing < 0) database.artifacts.push(redactClone(artifact));
      else database.artifacts[existing] = redactClone(artifact);
    });
  }

  async recordVerification(record: VerificationRecord): Promise<void> {
    await this.store.mutate((database) => {
      findOrchestration(database, record.orchestrationId);
      const safe = redactClone(record);
      safe.commandOrCheck = redactString(safe.commandOrCheck, 1_000);
      safe.outputSummary = redactString(safe.outputSummary, 8_000);
      upsertById(database.verifications, safe);
    });
  }

  private async elaborate(
    orchestrationId: string,
    workspacePath: string,
    revision: number,
    signal: AbortSignal,
    promptOverride?: string,
  ): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId).orchestration;
    const result = await this.driver.elaborateIntent(
      {
        orchestrationId,
        agentId: orchestration.agentId,
        prompt: redactString(promptOverride ?? orchestration.prompt, 50_000),
        requestedMode: orchestration.requestedMode,
        budget: orchestration.budget,
        workspacePath,
      },
      this,
      signal,
    );
    if (signal.aborted) return;
    await this.store.mutate((database) => {
      const current = findOrchestration(database, orchestrationId);
      if (current.status !== "drafting-intent") return;
      const draft: IntentDraft = {
        ...redactClone(result.draft),
        id: this.newId(),
        orchestrationId,
        revision,
        createdAt: this.now().toISOString(),
      };
      database.intentDrafts.push(draft);
      current.currentIntentDraftId = draft.id;
      current.estimate = redactClone(result.estimate);
      assertTransition(current.status, "awaiting-confirmation");
      current.status = "awaiting-confirmation";
      current.updatedAt = this.now().toISOString();
      database.events.push(
        this.makeEvent(orchestrationId, "intent-drafted", `Intent revision ${revision} is ready for user review`, {
          revision,
        }),
        this.makeEvent(orchestrationId, "cost-estimated", "A pre-execution token and estimated-cost range was recorded", {
          pricingStatus: result.estimate.pricingStatus,
          inputTokenLow: result.estimate.inputTokenLow,
          inputTokenHigh: result.estimate.inputTokenHigh,
          outputTokenLow: result.estimate.outputTokenLow,
          outputTokenHigh: result.estimate.outputTokenHigh,
        }),
        this.makeEvent(orchestrationId, "state-changed", "Awaiting explicit user confirmation", {
          from: "drafting-intent",
          to: "awaiting-confirmation",
        }),
      );
    });
  }

  private async plan(
    orchestrationId: string,
    workspacePath: string,
    contract: ExecutionContract,
    signal: AbortSignal,
  ): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId).orchestration;
    const result = await this.driver.plan(
      { orchestration, contract, workspacePath },
      this,
      signal,
    );
    if (signal.aborted) return;
    await this.store.mutate((database) => {
      const current = findOrchestration(database, orchestrationId);
      if (current.status !== "planning") return;
      current.selectedMode = result.selectedMode;
      current.status = "ready";
      current.updatedAt = this.now().toISOString();
      database.plans = database.plans.filter(
        (entry) => entry.orchestrationId !== orchestrationId,
      );
      database.plans.push({
        orchestrationId,
        selectedMode: result.selectedMode,
        routeReason: redactString(result.routeReason, 2_000),
        applicationMapVersion: result.applicationMap.version,
        createdAt: this.now().toISOString(),
      });
      database.tasks = database.tasks.filter(
        (entry) => entry.orchestrationId !== orchestrationId,
      );
      database.tasks.push(...redactClone(result.tasks));
      const mapIndex = database.applicationMaps.findIndex(
        (entry) => entry.orchestrationId === orchestrationId && entry.version === result.applicationMap.version,
      );
      if (mapIndex < 0) database.applicationMaps.push(redactClone(result.applicationMap));
      else database.applicationMaps[mapIndex] = redactClone(result.applicationMap);
      database.events.push(
        this.makeEvent(orchestrationId, "plan-ready", "The confirmed contract was planned and is ready for explicit start", {
          selectedMode: result.selectedMode,
          taskCount: result.tasks.length,
          applicationMapVersion: result.applicationMap.version,
        }),
      );
    });
  }

  private async execute(
    orchestrationId: string,
    workspacePath: string,
    contract: ExecutionContract,
    plan: PlanResult,
    signal: AbortSignal,
  ): Promise<void> {
    const orchestration = this.getOrchestration(orchestrationId).orchestration;
    const outcome = await this.driver.execute(
      { orchestration, contract, workspacePath, plan },
      this,
      signal,
    );
    if (signal.aborted && outcome.kind !== "cancelled") return;
    await this.store.mutate((database) => {
      const current = findOrchestration(database, orchestrationId);
      if (isTerminalStatus(current.status)) return;
      const now = this.now().toISOString();
      if (outcome.kind === "completed") {
        assertTransition(current.status, "integrating");
        current.status = "integrating";
        database.events.push(this.makeEvent(orchestrationId, "integration", "Execution changes entered deterministic-first integration", {}));
        assertTransition(current.status, "verifying");
        current.status = "verifying";
        database.events.push(this.makeEvent(orchestrationId, "verification", "Integrated candidate entered independent verification", {}));
        assertTransition(current.status, "completed");
        current.status = "completed";
        current.finalOutput = redactString(outcome.finalOutput, 20_000);
        current.completedAt = now;
        this.setCleanup(database, orchestrationId, "pending", "Verified execution completed; engine cleanup evidence is pending");
      } else if (outcome.kind === "needs-user") {
        assertTransition(current.status, "needs-user");
        current.status = "needs-user";
        const amendment = redactClone(outcome.amendment);
        amendment.id ||= this.newId();
        amendment.orchestrationId = orchestrationId;
        amendment.baseContractId = contract.id;
        amendment.status = "pending";
        amendment.material = true;
        amendment.createdAt = now;
        amendment.decidedAt = null;
        database.intentDrafts.push(amendment.proposedIntent);
        database.amendments.push(amendment);
        database.events.push(this.makeEvent(orchestrationId, "material-amendment-required", "Execution paused for explicit confirmation of a material amendment", { amendmentId: amendment.id }));
      } else if (outcome.kind === "budget-exhausted") {
        this.markBudgetExhausted(current, outcome.reason);
        database.events.push(this.makeEvent(orchestrationId, "budget-denied", outcome.reason, {}));
      } else if (outcome.kind === "cancelled") {
        assertTransition(current.status, "cancelled");
        current.status = "cancelled";
        current.error = redactString(outcome.reason);
        current.completedAt = now;
      } else {
        assertTransition(current.status, "failed");
        current.status = "failed";
        current.error = redactString(outcome.reason);
        current.completedAt = now;
      }
      current.updatedAt = now;
    });
  }

  private launch(
    orchestrationId: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): void {
    const controller = new AbortController();
    this.controllers.set(orchestrationId, controller);
    const promise = operation(controller.signal)
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        await this.store.mutate((database) => {
          const orchestration = findOrchestration(database, orchestrationId);
          if (isTerminalStatus(orchestration.status)) return;
          const message = redactString(
            error instanceof Error ? error.message : String(error),
          );
          if (orchestration.status === "running") {
            orchestration.status = "failed";
          } else if (orchestration.status === "drafting-intent" || orchestration.status === "planning") {
            orchestration.status = "failed";
          } else {
            return;
          }
          orchestration.error = message;
          orchestration.completedAt = this.now().toISOString();
          orchestration.updatedAt = orchestration.completedAt;
          database.events.push(
            this.makeEvent(orchestrationId, "failure", "Orchestration phase failed safely", {
              error: message,
            }),
          );
        });
      })
      .finally(() => {
        if (this.controllers.get(orchestrationId) === controller) {
          this.controllers.delete(orchestrationId);
        }
        if (this.background.get(orchestrationId) === promise) {
          this.background.delete(orchestrationId);
        }
      });
    this.background.set(orchestrationId, promise);
  }

  private async requireRunnableAgent(agentId: string): Promise<AgentAccessRecord> {
    const agent = await this.agentAccess.getAgent(agentId);
    if (!agent) throw new AgentUnavailableError(`Agent not found: ${agentId}`, 404);
    if (agent.status !== "ready") {
      throw new AgentUnavailableError(
        agent.status === "stopped"
          ? "A stopped Agent cannot begin orchestration"
          : `Agent is not available for orchestration (${agent.status})`,
      );
    }
    return agent;
  }

  private deriveCriteria(draft: IntentDraft): ContractCriterion[] {
    const criteria: ContractCriterion[] = [];
    const add = (
      kind: ContractCriterion["kind"],
      description: string,
      verification: ContractCriterion["verification"],
    ) => criteria.push({ id: this.newId(), kind, description, verification });
    for (const requirement of draft.requirements) add("functional", requirement, "visible-test");
    for (const decision of draft.architectureDecisions) add("architectural", decision, "static-check");
    add("scope", draft.nonGoals.length ? `Preserve non-goals: ${draft.nonGoals.join("; ")}` : "Preserve unrelated behavior and scope", "static-check");
    add("runtime", "Required automated checks pass in the trusted verification environment", "protected-test");
    for (const expectation of draft.manualExpectations) add("manual", expectation, "manual");
    if (!criteria.some((entry) => entry.kind === "functional")) add("functional", draft.goal, "visible-test");
    if (!criteria.some((entry) => entry.kind === "architectural")) add("architectural", "Preserve the confirmed architecture and public contracts", "static-check");
    return criteria;
  }

  private validateCriteria(criteria: ContractCriterion[]): void {
    if (!criteria.length || criteria.length > 250) {
      throw new OrchestrationSemanticError("Contract must contain 1 to 250 criteria");
    }
    const ids = new Set<string>();
    for (const criterion of criteria) {
      if (!criterion.id || ids.has(criterion.id) || !criterion.description.trim()) {
        throw new OrchestrationSemanticError("Contract criteria need unique IDs and descriptions");
      }
      ids.add(criterion.id);
    }
    for (const required of ["functional", "architectural", "scope", "runtime"] as const) {
      if (!criteria.some((entry) => entry.kind === required)) {
        throw new OrchestrationSemanticError(`Contract is missing a ${required} criterion`);
      }
    }
  }

  private markBudgetExhausted(orchestration: Orchestration, reason: string): void {
    if (isTerminalStatus(orchestration.status)) return;
    orchestration.status = "budget-exhausted";
    orchestration.error = redactString(reason);
    orchestration.updatedAt = this.now().toISOString();
    orchestration.completedAt = orchestration.updatedAt;
  }

  private setCleanup(
    database: OrchestrationDatabase,
    orchestrationId: string,
    status: "pending" | "cleaned" | "archived" | "retained" | "failed",
    summary: string,
  ): void {
    const value = {
      orchestrationId,
      policy: this.cleanupPolicy,
      status,
      summary: redactString(summary, 2_000),
      updatedAt: this.now().toISOString(),
    } as const;
    const index = database.cleanup.findIndex(
      (entry) => entry.orchestrationId === orchestrationId,
    );
    if (index < 0) database.cleanup.push(value);
    else database.cleanup[index] = value;
  }

  private makeEvent(
    orchestrationId: string,
    type: string,
    summary: string,
    metadata: Record<string, string | number | boolean | null>,
    taskId: string | null = null,
    executionId: string | null = null,
    actorRole: OrchestrationEvent["actorRole"] = "control-plane",
    modelId: string | null = null,
  ): OrchestrationEvent {
    return redactClone({
      id: this.newId(),
      orchestrationId,
      taskId,
      executionId,
      type,
      actorRole,
      modelId,
      summary: redactString(summary),
      metadata,
      createdAt: this.now().toISOString(),
    });
  }
}

export function createAgentExecutionCoordinator(
  service: OrchestrationControlService,
): AgentExecutionCoordinator {
  return service.coordinator();
}
