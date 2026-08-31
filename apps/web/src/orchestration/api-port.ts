import type { BenchmarkRecord, BudgetPolicy, ContractCriterion, OrchestrationReadModel, OrchestrationSummary, RequestedMode } from "./contracts";

export interface OrchestrationApi {
  list(agentId: string): Promise<{ orchestrations: OrchestrationSummary[] }>;
  create(agentId: string, input: { prompt: string; requestedMode: RequestedMode; budget?: Partial<BudgetPolicy> }): Promise<{ orchestration: OrchestrationSummary }>;
  get(id: string): Promise<OrchestrationReadModel>;
  reviseIntent(id: string, revision: string): Promise<unknown>;
  confirm(id: string, criteria?: ContractCriterion[], answers?: string[]): Promise<unknown>;
  start(id: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  recover(id: string): Promise<{ orchestration: OrchestrationSummary }>;
  retryVerification(id: string): Promise<{ orchestration: OrchestrationSummary }>;
  confirmAmendment(id: string, amendmentId: string, response?: string): Promise<unknown>;
  rejectAmendment(id: string, amendmentId: string): Promise<unknown>;
  createBenchmark(agentId: string, input: { prompt: string; criteria: ContractCriterion[] }): Promise<{ benchmark: BenchmarkRecord }>;
  getBenchmark(id: string): Promise<{ benchmark: BenchmarkRecord }>;
}
