import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { OrchestrationStore } from "./orchestration/control/store.js";
import { OrchestrationControlService } from "./orchestration/control/service.js";
import { ContextAwareExecutionDriver } from "./orchestration/engine/driver.js";
import { BenchmarkService, BenchmarkStore, type BenchmarkSnapshot } from "./orchestration/benchmark/service.js";
import { createLiveBenchmarkExecutor } from "./orchestration/benchmark/live-executor.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
let orchestration: OrchestrationControlService | null = null;
const service = new AgentService(config, store, workspaces, runner, {
  assertAgentAvailableForDirect: (agentId) => orchestration?.assertAgentAvailableForDirect(agentId) ?? Promise.resolve(),
  hasActiveOrchestration: (agentId) => orchestration?.hasActiveOrchestration(agentId) ?? false,
  cancelForAgent: (agentId) => orchestration?.cancelForAgent(agentId) ?? Promise.resolve(false),
});
await service.initialize();

const executionDriver = new ContextAwareExecutionDriver({
  runner,
  models: config.orchestrationModels,
  runtimeHomeRoot: config.orchestrationRuntimeHomeRoot,
  tempRoot: config.orchestrationTempRoot,
  archiveRoot: config.orchestrationArchiveRoot,
  protectedEvaluatorRoot: config.orchestrationProtectedEvaluatorRoot,
  modelCallTimeoutMs: config.codexTimeoutMs,
  modelTransportMaxRetries: Math.max(config.arkRequestMaxRetries, config.arkStreamMaxRetries),
  verificationChecks: [
    { id: "workspace-readable", description: "Candidate workspace is readable", scope: "worker-visible", run: async (candidate) => { const info = await stat(candidate); return { passed: info.isDirectory(), summary: info.isDirectory() ? "Candidate workspace is readable" : "Candidate workspace is not a directory" }; } },
    { id: "protected-boundary", description: "Protected evaluator remains outside the candidate", scope: "protected", run: async (candidate) => ({ passed: !path.resolve(config.orchestrationProtectedEvaluatorRoot).startsWith(path.resolve(candidate) + path.sep), summary: "Protected evaluator boundary remained separate" }) },
    { id: "global-map", description: "Published workspace has a readable file manifest", scope: "global", run: async (candidate) => { const entries = await readdir(candidate); return { passed: entries.length > 0, summary: `Global manifest contains ${entries.length} top-level entries` }; } },
  ],
});
orchestration = new OrchestrationControlService({
  store: new OrchestrationStore(path.join(config.dataDirectory, "orchestrations.json")),
  driver: executionDriver,
  agentAccess: { getAgent: (agentId) => { try { return service.getAgent(agentId); } catch { return null; } } },
  defaultBudget: config.orchestrationDefaultBudget,
  pricing: config.orchestrationPricing,
});
await orchestration.initialize();

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (["node_modules", ".git", "dist"].includes(name)) continue;
      const absolute = path.join(directory, name);
      const info = await stat(absolute);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) { hash.update(path.relative(root, absolute)); hash.update(await readFile(absolute)); }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

const benchmarkRoot = path.join(config.dataDirectory, "benchmark-workspaces");
const benchmarkExecutor = createLiveBenchmarkExecutor({ runner, driver: executionDriver, plannerModel: config.orchestrationModels.planner, runtimeHomeRoot: config.orchestrationRuntimeHomeRoot, defaultBudget: config.orchestrationDefaultBudget });
const benchmark = new BenchmarkService(
  new BenchmarkStore(path.join(config.dataDirectory, "benchmarks.json")),
  { snapshot: async (agentId, benchmarkId): Promise<BenchmarkSnapshot> => {
    const agent = service.getAgent(agentId);
    const root = path.join(benchmarkRoot, benchmarkId);
    const source = path.join(root, "source");
    await mkdir(root, { recursive: true });
    await cp(agent.workspacePath, source, { recursive: true, errorOnExist: true });
    return { hash: await hashDirectory(source), createIsolatedCopy: async (label) => { const destination = path.join(root, label); await cp(source, destination, { recursive: true, errorOnExist: true }); return destination; }, cleanup: async () => { await rm(root, { recursive: true, force: true }); } };
  } },
  benchmarkExecutor,
);
await benchmark.initialize();

const app = await createApp(config, service, { orchestration, benchmark });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
