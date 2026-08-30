import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AgentRunner } from "../types.js";
import type { JsonStore } from "../store.js";
import type { AgentWorkspaceLookup, BenchmarkArmResult, BenchmarkExecutor, BenchmarkRunInput } from "./benchmark/service.js";
import { BenchmarkService } from "./benchmark/service.js";
import type { AgentAccessPort } from "./control/service.js";
import { OrchestrationControlService, createOrchestrationCoordinator } from "./control/service.js";
import { OrchestrationStore } from "./control/store.js";
import {
  DEFAULT_BUDGET_POLICY,
  commitModelUsage,
  createEmptyUsageLedger,
  reserveModelCall,
  type PricingTable,
} from "./control/budget-ledger.js";
import type {
  ExecutionContract,
  ModelRole,
  Orchestration,
  OrchestrationExecutionDriver,
  OrchestrationSink,
} from "./contracts.js";
import { createEngineDriver, type EngineConfig } from "./engine/driver.js";
import { createTrustedCommandRunner } from "./engine/verification.js";

/**
 * Final-Assembly-owned composition glue: not claimed by any of Tasks 1-3's
 * file-ownership tables. Builds the real engine driver, control service,
 * and benchmark executors from `AppConfig`, and adapts the baseline
 * `JsonStore` to the small ports Task 1/3 expect, so `index.ts` stays a
 * thin entrypoint.
 */

export function createAgentAccessPort(store: JsonStore): AgentAccessPort {
  return {
    getAgent(agentId) {
      const agent = store.snapshot().agents.find((item) => item.id === agentId);
      return agent ? { id: agent.id, status: agent.status, workspacePath: agent.workspacePath } : null;
    },
  };
}

export function createAgentWorkspaceLookup(store: JsonStore): AgentWorkspaceLookup {
  return {
    getWorkspacePath(agentId) {
      return store.snapshot().agents.find((item) => item.id === agentId)?.workspacePath ?? null;
    },
  };
}

function buildEngineConfig(config: AppConfig, runner: AgentRunner): EngineConfig {
  const globalCheck = config.orchestrationGlobalCheck;
  return {
    runner,
    modelIds: config.orchestrationModelIds,
    defaultModelId: config.arkModel || "ep-not-configured",
    scratchRoot: config.orchestrationScratchRoot,
    checkRunner: globalCheck
      ? createTrustedCommandRunner([{ name: "global-check", command: globalCheck.command, args: globalCheck.args }])
      : async (check) => ({
          status: "skipped",
          outputSummary: `No trusted command configured for check "${check.name}"`,
        }),
    protectedChecks: [],
    globalChecks: globalCheck ? [{ name: "global-check", scope: "global" }] : [],
  };
}

interface BenchmarkMetrics {
  modelCalls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
}

/**
 * A real (not test-only) in-memory `OrchestrationSink`: budget accounting
 * uses the same pure functions Task 1's control plane uses, just not
 * persisted to `orchestrations.json` — consistent with the benchmark
 * module's own documented in-memory-only persistence model (see
 * docs/handoffs/task-3-experience-evidence.md).
 */
function createBenchmarkSink(
  pricing: PricingTable | undefined,
  metrics: BenchmarkMetrics,
): { sink: OrchestrationSink; getUsage: () => ReturnType<typeof createEmptyUsageLedger> } {
  let usage = createEmptyUsageLedger();
  const pending = new Map<string, { role: ModelRole; modelId: string }>();
  const sink: OrchestrationSink = {
    async reserveModelCall(input) {
      const decision = reserveModelCall(usage, DEFAULT_BUDGET_POLICY, input, pricing);
      if (decision.allowed) {
        pending.set(decision.reservationId, { role: input.role, modelId: input.modelId });
        metrics.modelCalls += 1;
      }
      return decision;
    },
    async commitModelUsage(reservationId, actual) {
      const pendingEntry = pending.get(reservationId);
      if (!pendingEntry) return;
      pending.delete(reservationId);
      usage = commitModelUsage(usage, pendingEntry.role, pendingEntry.modelId, actual, pricing);
    },
    async recordEvent(event) {
      if (event.type === "context-expansion-granted") metrics.contextExpansions += 1;
    },
    async upsertTask() {},
    async recordApplicationMap() {},
    async recordContextPacket() {},
    async recordAttempt() {
      metrics.attempts += 1;
    },
    async publishArtifact() {},
    async recordVerification(record) {
      if (record.status === "failed" && record.scope !== "worker-visible") metrics.integrationFailures += 1;
    },
  };
  return { sink, getUsage: () => usage };
}

function buildSyntheticContract(orchestrationId: string, prompt: string, criteria: BenchmarkRunInput["criteria"]): ExecutionContract {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    orchestrationId,
    version: 1,
    intent: {
      id: randomUUID(),
      orchestrationId,
      revision: 0,
      goal: prompt,
      requirements: [],
      assumptions: [],
      nonGoals: [],
      architectureDecisions: [],
      manualExpectations: [],
      openQuestions: [],
      createdAt: now,
    },
    criteria,
    confirmedBy: "user",
    confirmedAt: now,
    supersedesContractId: null,
  };
}

function buildSyntheticOrchestration(
  id: string,
  prompt: string,
  contractId: string,
  requestedMode: "direct" | "orchestrated",
): Orchestration {
  const now = new Date().toISOString();
  return {
    id,
    agentId: "benchmark",
    prompt,
    requestedMode,
    selectedMode: null,
    status: "running",
    currentIntentDraftId: null,
    activeContractId: contractId,
    estimate: null,
    budget: DEFAULT_BUDGET_POLICY,
    usage: createEmptyUsageLedger(),
    finalOutput: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/**
 * Wraps the real engine driver as a `BenchmarkExecutor` for one arm. The
 * "direct" arm forces `selectedMode: "direct"`; the "orchestrated" arm asks
 * the real router (`driver.plan()`) to decide, against the isolated
 * workspace snapshot the benchmark service already created.
 */
function createBenchmarkExecutor(
  driver: OrchestrationExecutionDriver,
  pricing: PricingTable | undefined,
  arm: "direct" | "orchestrated",
): BenchmarkExecutor {
  return {
    async run(input: BenchmarkRunInput): Promise<BenchmarkArmResult> {
      const startedAt = Date.now();
      const orchestrationId = randomUUID();
      const contract = buildSyntheticContract(orchestrationId, input.prompt, input.criteria);
      const orchestration = buildSyntheticOrchestration(orchestrationId, input.prompt, contract.id, arm);
      const metrics: BenchmarkMetrics = { modelCalls: 0, attempts: 0, contextExpansions: 0, escalations: 0, integrationFailures: 0 };
      const { sink, getUsage } = createBenchmarkSink(pricing, metrics);

      const plan =
        arm === "direct"
          ? {
              selectedMode: "direct" as const,
              routeReason: "Benchmark direct arm: forced direct execution",
              tasks: [],
              applicationMap: {
                orchestrationId,
                version: 1,
                repositoryHash: "",
                summary: "",
                fileCount: 0,
                createdAt: new Date().toISOString(),
              },
            }
          : await driver.plan({ orchestration, contract, workspacePath: input.workspacePath }, sink, input.signal);

      const outcome = await driver
        .execute({ orchestration, contract, workspacePath: input.workspacePath, plan }, sink, input.signal)
        .catch((error) => ({ kind: "failed" as const, reason: error instanceof Error ? error.message : String(error) }));

      if (outcome.kind === "needs-user") metrics.escalations += 1;

      const usage = getUsage();
      const modelIds: Record<string, string> = {};
      for (const [role, roleUsage] of Object.entries(usage.byRole)) {
        if (roleUsage) modelIds[role] = roleUsage.modelId;
      }

      return {
        mode: arm,
        modelIds,
        success: outcome.kind === "completed",
        verificationSummary:
          outcome.kind === "completed"
            ? outcome.finalOutput
            : outcome.kind === "needs-user"
              ? `Paused for user input: ${outcome.amendment.reason}`
              : outcome.kind === "budget-exhausted" || outcome.kind === "cancelled" || outcome.kind === "failed"
                ? outcome.reason
                : "Unknown outcome",
        totalInputTokens: usage.totalInputTokens,
        totalCachedInputTokens: usage.totalCachedInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        estimatedUsd: usage.totalEstimatedUsd,
        pricingStatus: usage.pricingStatus,
        wallClockMs: Date.now() - startedAt,
        modelCalls: metrics.modelCalls,
        attempts: metrics.attempts,
        contextExpansions: metrics.contextExpansions,
        escalations: metrics.escalations,
        integrationFailures: metrics.integrationFailures,
        error:
          outcome.kind === "failed" || outcome.kind === "budget-exhausted" || outcome.kind === "cancelled"
            ? outcome.reason
            : null,
      };
    },
  };
}

export interface OrchestrationComposition {
  orchestrationStore: OrchestrationStore;
  controlService: OrchestrationControlService;
  benchmarkService: BenchmarkService;
}

export async function composeOrchestration(
  config: AppConfig,
  agentStore: JsonStore,
  runner: AgentRunner,
): Promise<OrchestrationComposition> {
  const engineConfig = buildEngineConfig(config, runner);
  const driver = createEngineDriver(engineConfig);

  const orchestrationStore = new OrchestrationStore(path.join(config.dataDirectory, "orchestrations.json"));
  const controlService = new OrchestrationControlService(
    orchestrationStore,
    createAgentAccessPort(agentStore),
    driver,
    config.orchestrationPricing ?? undefined,
  );
  await controlService.initialize();

  const benchmarkScratchRoot = path.join(config.orchestrationScratchRoot, "benchmarks");
  const benchmarkService = new BenchmarkService(
    createAgentWorkspaceLookup(agentStore),
    createBenchmarkExecutor(driver, config.orchestrationPricing ?? undefined, "direct"),
    createBenchmarkExecutor(driver, config.orchestrationPricing ?? undefined, "orchestrated"),
    benchmarkScratchRoot,
  );

  return { orchestrationStore, controlService, benchmarkService };
}

export { createOrchestrationCoordinator };
