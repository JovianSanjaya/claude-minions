import type {
  BenchmarkRecord,
  BudgetPolicy,
  ContractAmendment,
  ContractCriterion,
  ExecutionContract,
  Orchestration,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationTask,
  RequestedExecutionMode,
  SharedArtifact,
  VerificationRecord,
} from "./contracts";

/**
 * The typed boundary between `OrchestrationPanel` and the backend. Kept as
 * an interface (not a concrete client) so the panel compiles and its state
 * logic is testable against a fake implementation before Final Assembly
 * adapts the real authenticated `request()` helper from `../api.ts` to it.
 */
export interface OrchestrationApi {
  create(
    agentId: string,
    body: { prompt: string; requestedMode?: RequestedExecutionMode; budget?: Partial<BudgetPolicy> },
  ): Promise<{ orchestration: Orchestration }>;
  list(agentId: string): Promise<{ orchestrations: Orchestration[] }>;
  get(orchestrationId: string): Promise<OrchestrationReadModel>;
  reviseIntent(orchestrationId: string, note: string): Promise<{ orchestration: Orchestration }>;
  answerClarification(
    orchestrationId: string,
    questionId: string,
    answer: { optionId?: string; freeText?: string },
  ): Promise<{ orchestration: Orchestration }>;
  confirm(orchestrationId: string, criteria?: ContractCriterion[]): Promise<{ contract: ExecutionContract }>;
  proposeAmendment(
    orchestrationId: string,
    body: { reason: string; requirements?: string[]; assumptions?: string[]; nonGoals?: string[]; architectureDecisions?: string[]; manualExpectations?: string[] },
  ): Promise<{ amendment: ContractAmendment }>;
  confirmAmendment(orchestrationId: string, amendmentId: string): Promise<{ contract: ExecutionContract }>;
  rejectAmendment(orchestrationId: string, amendmentId: string): Promise<{ amendment: ContractAmendment }>;
  start(orchestrationId: string): Promise<{ orchestration: Orchestration }>;
  cancel(orchestrationId: string): Promise<{ orchestration: Orchestration }>;
  events(orchestrationId: string): Promise<{ events: OrchestrationEvent[] }>;
  tasks(orchestrationId: string): Promise<{ tasks: OrchestrationTask[] }>;
  artifacts(orchestrationId: string): Promise<{ artifacts: SharedArtifact[] }>;
  verifications(orchestrationId: string): Promise<{ verifications: VerificationRecord[] }>;
  createBenchmark(
    agentId: string,
    body: { prompt: string; criteria: ContractCriterion[] },
  ): Promise<{ benchmark: BenchmarkRecord }>;
  getBenchmark(benchmarkId: string): Promise<{ benchmark: BenchmarkRecord }>;
}
