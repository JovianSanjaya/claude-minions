import type { BenchmarkRecord, BudgetPolicy, ContractCriterion, ModelStrategy, OrchestrationReadModel, OrchestrationSummary, RequestedMode, WorkerRoutingPreference } from "./contracts";

export interface OrchestrationApi {
  list(agentId: string): Promise<{ orchestrations: OrchestrationSummary[] }>;
  create(agentId: string, input: { prompt: string; requestedMode: RequestedMode; modelStrategy: ModelStrategy; workerRouting: WorkerRoutingPreference; budget?: Partial<BudgetPolicy> }): Promise<{ orchestration: OrchestrationSummary }>;
  get(id: string): Promise<OrchestrationReadModel>;
  reviseIntent(id: string, revision: string): Promise<unknown>;
  confirm(id: string, criteria?: ContractCriterion[]): Promise<unknown>;
  start(id: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  confirmAmendment(id: string, amendmentId: string): Promise<unknown>;
  rejectAmendment(id: string, amendmentId: string): Promise<unknown>;
  createBenchmark(agentId: string, input: { prompt: string; criteria: ContractCriterion[] }): Promise<{ benchmark: BenchmarkRecord }>;
  getBenchmark(id: string): Promise<{ benchmark: BenchmarkRecord }>;
}
