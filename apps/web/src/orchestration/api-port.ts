import type {
  BenchmarkRecord,
  BudgetPolicy,
  ContractCriterion,
  OrchestrationSummary,
  RequestedExecutionMode,
} from "./contracts";

/**
 * The typed boundary between the orchestration UI and the control plane.
 *
 * `OrchestrationPanel` never calls `fetch` itself. Final Assembly implements
 * this interface once in `apps/web/src/api.ts`, reusing the existing
 * authenticated `request` helper and bearer token, and passes it in as a prop.
 * That keeps this module compiling and testable before Task 1's routes exist,
 * and guarantees the module contains no mock server of its own.
 *
 * Every method returns the raw parsed JSON body as `unknown`. `view-model.ts`
 * is the single place that validates and narrows it, so an unexpected or
 * unsafe server field can never reach a component untouched.
 *
 * Method signatures and JSDoc match Task 1's 13 registered routes exactly, so
 * an adapter is a direct one-line mapping per method.
 */

export class OrchestrationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OrchestrationApiError";
  }
}

export type BudgetOverrides = Partial<BudgetPolicy>;

export interface CreateOrchestrationInput {
  prompt: string;
  requestedMode: RequestedExecutionMode;
  budget?: BudgetOverrides;
}

export interface ReviseIntentInput {
  /**
   * Free-text correction from the user; the control plane records it as a new
   * draft revision rather than overwriting history. Task 1's wire body for
   * `PATCH .../intent` is `{ feedback }`.
   */
  feedback: string;
}

export interface ConfirmIntentInput {
  /**
   * Always `true`. Confirmation is stated explicitly and is never inferred
   * from a model message, a page view, or an absence of questions.
   */
  confirm: true;
  /** Answers the user supplied for unresolved material questions. */
  answers?: string[];
  /** Optional user-adjusted acceptance criteria. */
  criteria?: ContractCriterion[];
}

export interface CreateBenchmarkInput {
  prompt: string;
  criteria?: ContractCriterion[];
  budget?: BudgetOverrides;
}

export interface OrchestrationApi {
  /**
   * `POST /api/agents/:agentId/orchestrations` -> 202 `{ orchestration }`.
   */
  createOrchestration(
    agentId: string,
    input: CreateOrchestrationInput,
  ): Promise<unknown>;

  /** `GET /api/agents/:agentId/orchestrations` -> `{ orchestrations }`. */
  listOrchestrations(agentId: string): Promise<unknown>;

  /**
   * `GET /api/orchestrations/:orchestrationId` -> the read model at the TOP
   * level (not wrapped): `{ orchestration, intentDraft, activeContract, plan,
   * tasks, events, usage, budget, … }`.
   */
  getOrchestration(orchestrationId: string): Promise<unknown>;

  /** `PATCH /api/orchestrations/:orchestrationId/intent` -> 202. */
  reviseIntent(orchestrationId: string, input: ReviseIntentInput): Promise<unknown>;

  /** `POST /api/orchestrations/:orchestrationId/confirm` -> 202. */
  confirmIntent(orchestrationId: string, input: ConfirmIntentInput): Promise<unknown>;

  /** `POST /api/orchestrations/:orchestrationId/start` -> 202. */
  startOrchestration(orchestrationId: string): Promise<unknown>;

  /** `POST /api/orchestrations/:orchestrationId/cancel` -> 200, body `{ reason? }`. */
  cancelOrchestration(orchestrationId: string, reason?: string): Promise<unknown>;

  /** `POST /api/orchestrations/:id/amendments/:amendmentId/confirm`. */
  confirmAmendment(orchestrationId: string, amendmentId: string): Promise<unknown>;

  /** `POST /api/orchestrations/:id/amendments/:amendmentId/reject`, body `{ reason? }`. */
  rejectAmendment(
    orchestrationId: string,
    amendmentId: string,
    reason?: string,
  ): Promise<unknown>;

  /** `POST /api/agents/:agentId/benchmarks` -> 202 `{ benchmark }`. */
  createBenchmark(agentId: string, input: CreateBenchmarkInput): Promise<unknown>;

  /** `GET /api/benchmarks/:benchmarkId` -> `{ benchmark }`. */
  getBenchmark(benchmarkId: string): Promise<unknown>;

  /** `POST /api/benchmarks/:benchmarkId/cancel` -> 202 `{ benchmark }`. */
  cancelBenchmark(benchmarkId: string): Promise<unknown>;

  /**
   * Optional narrow reads. Task 1 also exposes `/events`, `/tasks`,
   * `/artifacts`, and `/verifications`, each wrapping its collection
   * (`{ events }`, `{ tasks }`, `{ artifacts }`, `{ verifications }`). The read
   * model already carries this data, so the panel does not require them; a host
   * that prefers them can fold their responses in with
   * `mergeCollections` from `view-model.ts`.
   */
  listEvents?(orchestrationId: string): Promise<unknown>;
  listTasks?(orchestrationId: string): Promise<unknown>;
  listArtifacts?(orchestrationId: string): Promise<unknown>;
  listVerifications?(orchestrationId: string): Promise<unknown>;
}

/** Convenience aliases for the values the panel hands back to the host app. */
export type OrchestrationSummaryList = OrchestrationSummary[];
export type BenchmarkResult = BenchmarkRecord;
