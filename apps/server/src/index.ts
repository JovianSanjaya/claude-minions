import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig, buildCodexConfigToml } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { createDemoCheckCatalog } from "./demo-check-catalog.js";
import {
  createDirectBenchmarkExecutor,
  createOrchestratedBenchmarkExecutor,
} from "./benchmark-executors.js";
import { OrchestrationStore } from "./orchestration/control/store.js";
import {
  OrchestrationControlService,
  createAgentExecutionCoordinator,
  type AgentAccessPort,
} from "./orchestration/control/service.js";
import { OrchestrationEngineDriver } from "./orchestration/engine/driver.js";
import {
  BenchmarkService,
  FileBenchmarkStore,
  FileSystemBenchmarkWorkspaceProvider,
} from "./orchestration/benchmark/service.js";
import type { PricingTable as ControlPricingTable } from "./orchestration/control/budget-ledger.js";
import type { AgentExecutionCoordinator } from "./types.js";

/**
 * Task 2's `config.orchestration.pricing` (browser/env-facing, each field
 * optional and named `input`/`cachedInput`/`output`) and Task 1's
 * `PricingTable` (each field required, in full
 * `...UsdPerMillionTokens` form) are two independently designed shapes for
 * the same concept. A missing sub-field is treated as free (0), matching how
 * an operator who only prices, say, input tokens would expect the unset
 * dimensions to behave; a model missing from the table entirely still keeps
 * `pricingStatus: "unknown"` end to end, since that is decided by table
 * membership, not by any individual field.
 */
function toControlPricingTable(
  table: import("./config.js").ModelPricingTable,
): ControlPricingTable {
  const converted: Record<
    string,
    { inputUsdPerMillionTokens: number; cachedInputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }
  > = {};
  for (const [modelId, price] of Object.entries(table)) {
    converted[modelId] = {
      inputUsdPerMillionTokens: price.input ?? 0,
      cachedInputUsdPerMillionTokens: price.cachedInput ?? 0,
      outputUsdPerMillionTokens: price.output ?? 0,
    };
  }
  return converted;
}

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);

// ---------------------------------------------------------------------
// Orchestration middleware composition.
//
// Order matters: the engine driver has no durable state of its own, the
// control plane persists orchestrations and enforces the budget/state
// machine, and the coordinator is what makes a direct Run and an active
// orchestration mutually exclusive on one Agent workspace. Everything is
// initialized before `app.listen` so restart reconciliation runs first.
// ---------------------------------------------------------------------

const checkCatalog = createDemoCheckCatalog();

const engineDriver = new OrchestrationEngineDriver({
  runner,
  tempRoot: config.orchestration.tempRoot,
  archiveRoot: config.orchestration.archiveRoot,
  runtimeHomeRoot: config.orchestration.runtimeHomeRoot,
  protectedEvaluatorRoot: config.orchestration.protectedEvaluatorRoot,
  models: config.orchestration.models,
  pricing: config.orchestration.pricing,
  cleanupPolicy: config.orchestration.cleanupPolicy,
  checkCatalog,
  // Seed every fresh per-role CODEX_HOME the driver creates with the same
  // Ark-pointing config.toml the main direct-run CODEX_HOME gets from
  // writeCodexConfig() above -- otherwise orchestration executions silently
  // fall back to Codex CLI's OpenAI default. See buildCodexConfigToml's doc
  // comment in config.ts.
  codexConfigToml: buildCodexConfigToml(config),
});

const orchestrationStore = new OrchestrationStore(
  path.join(config.dataDirectory, "orchestrations.json"),
);

// Constructed lazily below, after `service` exists, so the port can look up
// real Agent records. `service` is declared with `let` so this closure sees
// the final instance even though it is defined before `service` is created.
let agentServiceRef: AgentService | null = null;
const agentAccess: AgentAccessPort = {
  async getAgent(agentId) {
    if (!agentServiceRef) return null;
    try {
      const agent = agentServiceRef.getAgent(agentId);
      return { id: agent.id, status: agent.status, workspacePath: agent.workspacePath };
    } catch {
      return null;
    }
  },
};

const pricingTable = toControlPricingTable(config.orchestration.pricing);

const control = new OrchestrationControlService({
  store: orchestrationStore,
  driver: engineDriver,
  agents: agentAccess,
  pricing: pricingTable,
  defaultBudget: config.orchestration.budget,
  logger: {
    error(message, error) {
      console.error(message, error);
    },
  },
});

const rawControlCoordinator = createAgentExecutionCoordinator(control);
// Adapt Task 1's coordinator (`cancelForAgent` resolves with a count) to the
// baseline `AgentExecutionCoordinator` port in types.ts (resolves `void`).
// This is a pure composition-root shim; neither task's file changes.
const controlCoordinator: AgentExecutionCoordinator = {
  assertAgentAvailableForDirect: (agentId) =>
    rawControlCoordinator.assertAgentAvailableForDirect(agentId),
  hasActiveOrchestration: (agentId) => rawControlCoordinator.hasActiveOrchestration(agentId),
  cancelForAgent: (agentId) => rawControlCoordinator.cancelForAgent(agentId).then(() => undefined),
};

// AgentService gets the coordinator so a direct Playground Run refuses to
// start while an orchestration owns the workspace, and so stopping/deleting
// an Agent cancels its orchestration first.
const service = new AgentService(config, store, workspaces, runner, controlCoordinator);
agentServiceRef = service;

const benchmarkService = new BenchmarkService({
  agents: {
    async getAgent(agentId) {
      try {
        const agent = service.getAgent(agentId);
        return { id: agent.id, status: agent.status, workspacePath: agent.workspacePath };
      } catch {
        return null;
      }
    },
  },
  workspaces: new FileSystemBenchmarkWorkspaceProvider(
    path.join(config.orchestration.tempRoot, "benchmarks"),
    config.orchestration.cleanupPolicy === "retain",
  ),
  executors: {
    direct: createDirectBenchmarkExecutor({
      runner,
      modelId: config.orchestration.models.fallbackModelId,
      checkCatalog,
      pricing: pricingTable,
    }),
    orchestrated: createOrchestratedBenchmarkExecutor({
      driver: engineDriver,
      pricing: pricingTable,
    }),
  },
  store: new FileBenchmarkStore(path.join(config.dataDirectory, "benchmarks.json")),
  defaultBudget: config.orchestration.budget,
});

// Initialize everything before listening, so restart reconciliation
// (interrupted Runs, interrupted orchestrations, interrupted benchmarks) all
// resolve before the server accepts traffic.
await service.initialize();
await control.initialize();
await benchmarkService.initialize();

const app = await createApp(config, service, { control, benchmark: benchmarkService });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
