import { randomUUID } from "node:crypto";
import type { AgentRunner } from "../../types.js";
import type {
  ApplicationMapSummary,
  ContextPacketSummary,
  ExecutionContract,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationExecutionDriver,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import type { BenchmarkArmResult, BenchmarkExecutor } from "./service.js";

class EvidenceSink implements OrchestrationSink {
  readonly tasks: OrchestrationTask[] = [];
  readonly events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  readonly attempts: WorkerAttempt[] = [];
  readonly verifications: VerificationRecord[] = [];
  readonly artifacts: SharedArtifact[] = [];
  readonly contexts: ContextPacketSummary[] = [];
  readonly reservations = new Map<string, ModelCallReservation>();
  readonly models = new Set<string>();
  usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  async reserveModelCall(input: ModelCallReservation) { const id = randomUUID(); this.reservations.set(id, input); return { allowed: true as const, reservationId: id }; }
  async commitModelUsage(id: string, usage: TokenUsage) { const reservation = this.reservations.get(id); if (reservation) this.models.add(reservation.modelId); this.reservations.delete(id); this.usage.inputTokens += usage.inputTokens; this.usage.cachedInputTokens += usage.cachedInputTokens; this.usage.outputTokens += usage.outputTokens; }
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">) { this.events.push(event); }
  async upsertTask(task: OrchestrationTask) { const index = this.tasks.findIndex((entry) => entry.id === task.id); if (index < 0) this.tasks.push(task); else this.tasks[index] = task; }
  async recordApplicationMap(_map: ApplicationMapSummary) {}
  async recordContextPacket(packet: ContextPacketSummary) { this.contexts.push(packet); }
  async recordAttempt(attempt: WorkerAttempt) { const index = this.attempts.findIndex((entry) => entry.id === attempt.id); if (index < 0) this.attempts.push(attempt); else this.attempts[index] = attempt; }
  async publishArtifact(artifact: SharedArtifact) { this.artifacts.push(artifact); }
  async recordVerification(record: VerificationRecord) { this.verifications.push(record); }
}

export function createLiveBenchmarkExecutor(options: {
  runner: AgentRunner;
  driver: OrchestrationExecutionDriver;
  plannerModel: string;
  runtimeHomeRoot: string;
  defaultBudget: Orchestration["budget"];
}): BenchmarkExecutor {
  return { execute: async (input): Promise<BenchmarkArmResult> => {
    const started = Date.now();
    if (input.mode === "direct") {
      const executionId = randomUUID();
      const abort = () => { void options.runner.cancel(executionId); };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await options.runner.run({ executionId, agentId: `benchmark-${input.benchmarkId}`, workspacePath: input.workspacePath, prompt: `${input.prompt}\n\nSuccess criteria:\n${input.criteria.map((criterion) => `- ${criterion.description}`).join("\n")}\nRun appropriate checks and summarize the verified result.`, threadId: null, orchestrationId: input.benchmarkId, role: "planner", modelId: options.plannerModel, runtimeHomePath: `${options.runtimeHomeRoot}/benchmark-${executionId}`, sandboxMode: "workspace-write" });
        const passed = result.output.trim().length > 0;
        return { executionId, success: passed, verificationPassed: passed, verificationSummary: passed ? "Common non-empty-result check passed" : "No result was returned", modelIds: [result.modelId ?? options.plannerModel], logicalRoles: ["planner"], usage: { inputTokens: result.usage?.inputTokens ?? 0, cachedInputTokens: result.usage?.cachedInputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0 }, estimatedUsd: null, wallClockMs: Date.now() - started, calls: 1, attempts: 1, contextExpansions: 0, escalations: 0, integrationFailures: 0, outputSummary: result.output.slice(0, 4_000), error: null };
      } finally { input.signal.removeEventListener("abort", abort); }
    }

    const sink = new EvidenceSink();
    const createdAt = new Date().toISOString();
    const draft = { id: randomUUID(), orchestrationId: input.benchmarkId, revision: 1, goal: input.prompt, requirements: input.criteria.map((criterion) => criterion.description), assumptions: [], nonGoals: [], architectureDecisions: [], materialQuestions: [], manualExpectations: input.criteria.filter((criterion) => criterion.verification === "manual").map((criterion) => criterion.description), createdAt };
    const contract: ExecutionContract = { id: randomUUID(), orchestrationId: input.benchmarkId, version: 1, intent: draft, criteria: input.criteria.map((criterion) => ({ ...criterion })), confirmedBy: "user", confirmedAt: createdAt, supersedesContractId: null };
    const orchestration: Orchestration = { id: input.benchmarkId, agentId: `benchmark-${input.benchmarkId}`, prompt: input.prompt, requestedMode: "orchestrated", modelStrategy: "mixed", workerRouting: "adaptive", selectedMode: null, status: "planning", currentIntentDraftId: draft.id, activeContractId: contract.id, estimate: null, budget: { ...options.defaultBudget }, usage: { byRole: {}, totalInputTokens: 0, totalCachedInputTokens: 0, totalOutputTokens: 0, totalEstimatedUsd: null, pricingStatus: "unknown" }, finalOutput: null, error: null, createdAt, updatedAt: createdAt, completedAt: null };
    const abort = () => { void options.driver.cancel(input.benchmarkId); };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      const plan = await options.driver.plan({ orchestration, contract, workspacePath: input.workspacePath }, sink, input.signal);
      const outcome = await options.driver.execute({ orchestration: { ...orchestration, selectedMode: plan.selectedMode, status: "running" }, contract, workspacePath: input.workspacePath, plan }, sink, input.signal);
      const passed = outcome.kind === "completed" && sink.verifications.every((record) => record.scope === "manual" || record.status === "passed");
      return { executionId: input.benchmarkId, success: outcome.kind === "completed", verificationPassed: passed, verificationSummary: sink.verifications.length ? `${sink.verifications.filter((entry) => entry.status === "passed").length}/${sink.verifications.length} engine verification records passed` : "No configured engine checks produced records", modelIds: [...sink.models], logicalRoles: [...new Set(sink.events.map((event) => event.actorRole).filter((role): role is "planner" | "worker" | "verifier" | "integrator" => ["planner", "worker", "verifier", "integrator"].includes(role)))], usage: sink.usage, estimatedUsd: null, wallClockMs: Date.now() - started, calls: sink.events.filter((event) => event.type === "usage-committed").length || [...sink.models].length, attempts: sink.attempts.length, contextExpansions: sink.events.filter((event) => event.type.includes("context-expansion")).length, escalations: sink.events.filter((event) => event.type.includes("escalat")).length, integrationFailures: sink.events.filter((event) => /integrat.*fail|conflict/i.test(`${event.type} ${event.summary}`)).length, outputSummary: outcome.kind === "completed" ? outcome.finalOutput.slice(0, 4_000) : outcome.kind === "needs-user" ? outcome.amendment.reason : outcome.reason, error: outcome.kind === "completed" ? null : outcome.kind === "needs-user" ? outcome.amendment.reason : outcome.reason };
    } finally { input.signal.removeEventListener("abort", abort); }
  }};
}
