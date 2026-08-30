import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { AgentRunner } from "./types.js";
import type {
  ContractCriterion,
  ExecutionContract,
  ExecutionOutcome,
  IntentDraft,
  ModelCallReservation,
  BudgetDecision,
  Orchestration,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  ApplicationMapSummary,
  ContextPacketSummary,
  WorkerAttempt,
  SharedArtifact,
  TokenUsage,
  UsageLedger,
  VerificationRecord,
} from "./orchestration/contracts.js";
import type { OrchestrationEngineDriver } from "./orchestration/engine/driver.js";
import type {
  CommandExecutor,
  TrustedCheckDefinition,
} from "./orchestration/engine/verification.js";
import { ProcessCommandExecutor } from "./orchestration/engine/verification.js";
import {
  applyUsage,
  emptyUsageLedger,
  normalizeTokenUsage,
  PricingBook,
} from "./orchestration/control/budget-ledger.js";
import type { PricingTable } from "./orchestration/control/budget-ledger.js";
import { redactAndBound } from "./orchestration/benchmark/service.js";
import type {
  BenchmarkCounters,
  BenchmarkExecutor,
  BenchmarkExecutorInput,
  BenchmarkExecutorResult,
  BenchmarkVerificationSummary,
} from "./orchestration/benchmark/service.js";

/**
 * The one genuinely outstanding integration item both Task 2 and Task 3
 * flagged in their handoffs: real executors for the direct-vs-orchestrated
 * benchmark. Both arms honor `input.signal`, never observe each other's
 * output, and never trust a model's own claim of success — quality comes
 * from running the same checks, not from what the arm reports about itself.
 */

/** Used whenever a benchmark request supplies no criteria of its own — identical for both arms. */
export const DEFAULT_BENCHMARK_CRITERION: ContractCriterion = {
  id: "benchmark-default",
  kind: "runtime",
  description: "The Agent produced a real, non-empty response addressing the prompt.",
  verification: "protected-test",
};

function resolveCriteria(criteria: ContractCriterion[]): ContractCriterion[] {
  return criteria.length > 0 ? criteria : [DEFAULT_BENCHMARK_CRITERION];
}

async function runDemoChecks(
  criteria: ContractCriterion[],
  workspacePath: string,
  catalog: Record<string, TrustedCheckDefinition>,
  executor: CommandExecutor,
): Promise<BenchmarkVerificationSummary[]> {
  const summaries: BenchmarkVerificationSummary[] = [];
  for (const criterion of criteria) {
    if (criterion.verification === "manual") {
      summaries.push({
        scope: "manual",
        commandOrCheck: criterion.id,
        status: "skipped",
        outputSummary: "Manual acceptance required: " + criterion.description.slice(0, 200),
      });
      continue;
    }
    const definition = catalog[criterion.id];
    if (!definition) {
      summaries.push({
        scope: criterion.verification === "protected-test" ? "protected" : "global",
        commandOrCheck: criterion.id,
        status: "skipped",
        outputSummary: "No trusted automated check is configured for this criterion.",
      });
      continue;
    }
    const outcome = await executor.run({
      command: definition.command,
      args: definition.args,
      cwd: workspacePath,
      timeoutMs: definition.timeoutMs ?? 30_000,
    });
    summaries.push({
      scope: definition.scope,
      commandOrCheck: definition.id,
      status: outcome.exitCode === 0 ? "passed" : "failed",
      outputSummary: redactAndBound(outcome.output, 2_000),
    });
  }
  return summaries;
}

function usageLedgerFromTokens(
  role: "worker",
  modelId: string,
  tokens: TokenUsage,
  pricing: PricingBook,
): UsageLedger {
  return applyUsage(emptyUsageLedger(pricing.isConfigured), role, modelId, tokens, pricing);
}

/**
 * Direct arm: one real `AgentRunner` call against the arm's isolated
 * workspace copy, then the same trusted checks the orchestrated arm would
 * run for the same criteria. `succeeded` comes from those checks, not from
 * whether the model claimed to be done.
 */
export function createDirectBenchmarkExecutor(options: {
  runner: AgentRunner;
  modelId: string;
  checkCatalog: Record<string, TrustedCheckDefinition>;
  pricing?: PricingTable | undefined;
  commandExecutor?: CommandExecutor | undefined;
}): BenchmarkExecutor {
  const pricing = new PricingBook(options.pricing);
  const commandExecutor = options.commandExecutor ?? new ProcessCommandExecutor();
  return {
    arm: "direct",
    async execute(input: BenchmarkExecutorInput): Promise<BenchmarkExecutorResult> {
      const executionId = "bench-" + input.benchmarkId + "-direct-" + randomUUID();
      let output = "";
      let usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      let runError: string | null = null;
      try {
        const result = await options.runner.run({
          agentId: input.agentId,
          workspacePath: input.workspace.path,
          prompt: input.prompt,
          threadId: null,
          executionId,
          role: "worker",
          modelId: options.modelId || undefined,
        });
        output = result.output;
        usage = normalizeTokenUsage(result.usage ?? undefined);
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      }
      if (input.signal.aborted) {
        return {
          executionId,
          selectedMode: "direct",
          succeeded: false,
          verifications: [],
          usage: usageLedgerFromTokens("worker", options.modelId, usage, pricing),
          counters: { modelCalls: 1, attempts: 1, contextExpansions: 0, escalations: 0, integrationFailures: 0 },
          finalOutputSummary: "Cancelled",
          observedWorkspaceHash: null,
        };
      }
      const criteria = resolveCriteria(input.criteria);
      const verifications =
        runError === null
          ? await runDemoChecks(criteria, input.workspace.path, options.checkCatalog, commandExecutor)
          : [];
      const checked = verifications.filter((entry) => entry.status !== "skipped");
      const succeeded =
        runError === null && (checked.length > 0 ? checked.every((entry) => entry.status === "passed") : output.length > 0);
      const counters: BenchmarkCounters = {
        modelCalls: 1,
        attempts: 1,
        contextExpansions: 0,
        escalations: 0,
        integrationFailures: 0,
      };
      return {
        executionId,
        selectedMode: "direct",
        succeeded,
        verifications,
        usage: usageLedgerFromTokens("worker", options.modelId, usage, pricing),
        counters,
        finalOutputSummary: redactAndBound(runError ?? output, 2_000),
        observedWorkspaceHash: null,
      };
    },
  };
}

/** In-memory `OrchestrationSink` that just accumulates evidence for one benchmark arm. */
class RecordingSink implements OrchestrationSink {
  usage: UsageLedger;
  readonly verifications: VerificationRecord[] = [];
  readonly counters: BenchmarkCounters = {
    modelCalls: 0,
    attempts: 0,
    contextExpansions: 0,
    escalations: 0,
    integrationFailures: 0,
  };
  private readonly reservations = new Map<string, ModelCallReservation>();

  constructor(private readonly pricing: PricingBook) {
    this.usage = emptyUsageLedger(pricing.isConfigured);
  }

  async reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision> {
    const reservationId = randomUUID();
    this.reservations.set(reservationId, input);
    this.counters.modelCalls += 1;
    return { allowed: true, reservationId };
  }

  async commitModelUsage(reservationId: string, actual: TokenUsage): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    this.usage = applyUsage(
      this.usage,
      reservation.role,
      reservation.modelId,
      normalizeTokenUsage(actual),
      this.pricing,
    );
  }

  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {
    const type = event.type.toLowerCase();
    if (type.includes("expansion") && type.includes("grant")) this.counters.contextExpansions += 1;
    if (type.includes("escalat")) this.counters.escalations += 1;
    if (type.includes("integration") && (type.includes("conflict") || type.includes("fail"))) {
      this.counters.integrationFailures += 1;
    }
  }

  async upsertTask(_task: OrchestrationTask): Promise<void> {}
  async recordApplicationMap(_map: ApplicationMapSummary): Promise<void> {}
  async recordContextPacket(_packet: ContextPacketSummary): Promise<void> {}
  async recordAttempt(_attempt: WorkerAttempt): Promise<void> {
    this.counters.attempts += 1;
  }
  async publishArtifact(_artifact: SharedArtifact): Promise<void> {}
  async recordVerification(record: VerificationRecord): Promise<void> {
    this.verifications.push(record);
  }
}

function outcomeSummary(outcome: ExecutionOutcome): { succeeded: boolean; summary: string } {
  switch (outcome.kind) {
    case "completed":
      return { succeeded: true, summary: outcome.finalOutput };
    case "needs-user":
      return { succeeded: false, summary: "Needs user confirmation: " + outcome.amendment.reason };
    case "budget-exhausted":
      return { succeeded: false, summary: "Budget exhausted: " + outcome.reason };
    case "cancelled":
      return { succeeded: false, summary: "Cancelled: " + outcome.reason };
    case "failed":
      return { succeeded: false, summary: "Failed: " + outcome.reason };
  }
}

/**
 * Orchestrated arm: drives Task 2's real `OrchestrationEngineDriver`
 * directly (plan -> execute) against a synthesized contract built from the
 * benchmark's own prompt/criteria, targeting the arm's isolated workspace
 * copy. This exercises the real engine end to end without touching Task 1's
 * persisted control plane or the real Agent's own orchestration slot.
 */
export function createOrchestratedBenchmarkExecutor(options: {
  driver: OrchestrationEngineDriver;
  pricing?: PricingTable | undefined;
}): BenchmarkExecutor {
  const pricing = new PricingBook(options.pricing);
  return {
    arm: "orchestrated",
    async execute(input: BenchmarkExecutorInput): Promise<BenchmarkExecutorResult> {
      const orchestrationId = "bench-" + input.benchmarkId + "-orchestrated";
      const createdAt = new Date().toISOString();
      const criteria = resolveCriteria(input.criteria);
      const intent: IntentDraft = {
        id: orchestrationId + ":intent",
        orchestrationId,
        revision: 1,
        goal: input.prompt,
        requirements: [input.prompt],
        assumptions: [],
        nonGoals: [],
        architectureDecisions: [],
        materialQuestions: [],
        manualExpectations: [],
        createdAt,
      };
      const contract: ExecutionContract = {
        id: orchestrationId + ":contract",
        orchestrationId,
        version: 1,
        intent,
        criteria,
        confirmedBy: "user",
        confirmedAt: createdAt,
        supersedesContractId: null,
      };
      const orchestration: Orchestration = {
        id: orchestrationId,
        agentId: input.agentId,
        prompt: input.prompt,
        requestedMode: "orchestrated",
        selectedMode: null,
        status: "planning",
        currentIntentDraftId: intent.id,
        activeContractId: contract.id,
        estimate: null,
        budget: input.budget,
        usage: emptyUsageLedger(pricing.isConfigured),
        finalOutput: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      };
      const sink = new RecordingSink(pricing);
      try {
        const plan = await options.driver.plan(
          { orchestration, contract, workspacePath: input.workspace.path },
          sink,
          input.signal,
        );
        if (input.signal.aborted) throw new Error("Benchmark cancelled before execution");
        const outcome = await options.driver.execute(
          { orchestration, contract, workspacePath: input.workspace.path, plan },
          sink,
          input.signal,
        );
        const { succeeded, summary } = outcomeSummary(outcome);
        return {
          executionId: orchestrationId,
          selectedMode: plan.selectedMode,
          succeeded,
          verifications: sink.verifications.map((record) => ({
            scope: record.scope,
            commandOrCheck: record.commandOrCheck,
            status: record.status,
            outputSummary: record.outputSummary,
          })),
          usage: sink.usage,
          counters: { ...sink.counters },
          finalOutputSummary: redactAndBound(summary, 2_000),
          observedWorkspaceHash: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          executionId: orchestrationId,
          selectedMode: null,
          succeeded: false,
          verifications: sink.verifications.map((record) => ({
            scope: record.scope,
            commandOrCheck: record.commandOrCheck,
            status: record.status,
            outputSummary: record.outputSummary,
          })),
          usage: sink.usage,
          counters: { ...sink.counters },
          finalOutputSummary: redactAndBound(message, 2_000),
          observedWorkspaceHash: null,
        };
      } finally {
        await options.driver.cancel(orchestrationId).catch(() => undefined);
      }
    },
    async cancel(): Promise<void> {
      // Cancellation is honored via input.signal inside execute(); nothing to do here.
    },
  };
}
