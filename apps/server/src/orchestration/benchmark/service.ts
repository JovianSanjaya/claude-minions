import { randomUUID } from "node:crypto";
import { HttpError } from "../../errors.js";
import type { ContractCriterion } from "../contracts.js";
import { buildManifest, createTaskWorkspace } from "../engine/worker-workspaces.js";

/**
 * Direct-vs-orchestrated benchmark: measures whether delegation actually
 * improved quality, cost, or context use for a given task — or made things
 * worse, which is valid evidence too. This module is deliberately decoupled
 * from Task 1's control plane and Task 2's driver: it depends only on the
 * frozen `ContractCriterion` type and its own injected `BenchmarkExecutor`
 * port, so it compiles and tests standalone. Final Assembly wires the real
 * direct/orchestrated executors (thin adapters over Task 1's service and
 * Task 2's engine) and registers the routes.
 */

export type BenchmarkArm = "direct" | "orchestrated";

export interface BenchmarkArmResult {
  mode: BenchmarkArm;
  /** Logical-role -> model-id actually used for this arm. */
  modelIds: Record<string, string>;
  /** Whether this arm's own verification (whatever it ran) passed — quality is reported before cost. */
  success: boolean;
  verificationSummary: string;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  estimatedUsd: number | null;
  pricingStatus: "configured" | "unknown";
  wallClockMs: number;
  modelCalls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
  error: string | null;
}

export interface BenchmarkRunInput {
  /** An isolated workspace copy — the executor must not need or touch the original Agent workspace. */
  workspacePath: string;
  prompt: string;
  criteria: ContractCriterion[];
  signal: AbortSignal;
}

/** One arm of a benchmark. Direct and orchestrated arms are two different implementations of this same port. */
export interface BenchmarkExecutor {
  run(input: BenchmarkRunInput): Promise<BenchmarkArmResult>;
}

export interface AgentWorkspaceLookup {
  getWorkspacePath(agentId: string): string | null;
}

export interface BenchmarkRecord {
  id: string;
  agentId: string;
  workspaceSnapshotHash: string;
  prompt: string;
  criteria: ContractCriterion[];
  status: "running" | "completed" | "failed" | "cancelled";
  direct: BenchmarkArmResult | null;
  orchestrated: BenchmarkArmResult | null;
  /** Non-fatal caveats about whether the two arms are actually comparable (model differences, one failed, etc.). */
  comparabilityWarnings: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface CreateBenchmarkInput {
  agentId: string;
  prompt: string;
  criteria: ContractCriterion[];
}

function buildComparabilityWarnings(direct: BenchmarkArmResult, orchestrated: BenchmarkArmResult): string[] {
  const warnings: string[] = [];
  if (direct.success !== orchestrated.success) {
    warnings.push(
      "Quality differs between arms (one passed verification, the other did not) — cost/token comparisons below are not a meaningful basis for declaring a winner.",
    );
  }
  const directModels = new Set(Object.values(direct.modelIds));
  const orchestratedModels = new Set(Object.values(orchestrated.modelIds));
  const modelsDiffer =
    directModels.size !== orchestratedModels.size || [...directModels].some((id) => !orchestratedModels.has(id));
  if (modelsDiffer) {
    warnings.push(
      `Different underlying models were used (direct: ${[...directModels].join(", ") || "unknown"}; orchestrated: ${[...orchestratedModels].join(", ") || "unknown"}) — a cost or speed difference may reflect model choice, not delegation itself.`,
    );
  }
  if (direct.pricingStatus === "unknown" || orchestrated.pricingStatus === "unknown") {
    warnings.push("Dollar pricing is not configured for at least one arm — only token counts are comparable, not estimated cost.");
  }
  return warnings;
}

/**
 * Deterministic interpretation helper: never lets a token/dollar comparison
 * imply a "winner" when the arms didn't produce comparably valid results.
 * Exported so callers (the web view-model, or a CLI report) can reuse the
 * same rule instead of re-deriving it.
 */
export function interpretBenchmark(record: BenchmarkRecord): { verdict: string; safeToCompareCost: boolean } {
  if (!record.direct || !record.orchestrated) {
    return { verdict: "Benchmark is still running or incomplete.", safeToCompareCost: false };
  }
  if (record.direct.success !== record.orchestrated.success) {
    const winner = record.direct.success ? "direct" : "orchestrated";
    return {
      verdict: `Only the ${winner} arm passed verification — quality, not cost, decides this comparison.`,
      safeToCompareCost: false,
    };
  }
  if (!record.direct.success && !record.orchestrated.success) {
    return { verdict: "Neither arm passed verification.", safeToCompareCost: false };
  }
  if (record.direct.pricingStatus === "unknown" || record.orchestrated.pricingStatus === "unknown") {
    return {
      verdict: "Both arms passed verification with comparable quality; dollar cost is unknown for at least one arm, so only token totals are comparable.",
      safeToCompareCost: false,
    };
  }
  const directUsd = record.direct.estimatedUsd ?? 0;
  const orchestratedUsd = record.orchestrated.estimatedUsd ?? 0;
  const cheaper = directUsd <= orchestratedUsd ? "direct" : "orchestrated";
  return {
    verdict: `Both arms passed verification with comparable quality; ${cheaper} was cheaper by estimated cost.`,
    safeToCompareCost: true,
  };
}

export class BenchmarkService {
  private readonly records = new Map<string, BenchmarkRecord>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly agents: AgentWorkspaceLookup,
    private readonly directExecutor: BenchmarkExecutor,
    private readonly orchestratedExecutor: BenchmarkExecutor,
    private readonly scratchRoot: string,
  ) {}

  getBenchmark(id: string): BenchmarkRecord {
    const record = this.records.get(id);
    if (!record) throw new HttpError(404, "Benchmark not found");
    return record;
  }

  /** Test-only: await the background run started by createBenchmark. */
  async waitForPendingWork(id: string): Promise<void> {
    await (this.pending.get(id) ?? Promise.resolve());
  }

  async createBenchmark(input: CreateBenchmarkInput): Promise<BenchmarkRecord> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new HttpError(400, "prompt must not be empty");
    if (input.criteria.length === 0) throw new HttpError(400, "At least one criterion is required");
    const workspacePath = this.agents.getWorkspacePath(input.agentId);
    if (!workspacePath) throw new HttpError(404, "Agent not found");

    const baseManifest = await buildManifest(workspacePath);
    const workspaceSnapshotHash = baseManifest.map((entry) => `${entry.path}:${entry.sha256}`).join("|");

    const record: BenchmarkRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      workspaceSnapshotHash,
      prompt,
      criteria: input.criteria,
      status: "running",
      direct: null,
      orchestrated: null,
      comparabilityWarnings: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.records.set(record.id, record);

    const promise = this.runBenchmark(record.id, workspacePath).catch((error) => {
      const current = this.records.get(record.id);
      if (!current) return;
      current.status = "failed";
      current.completedAt = new Date().toISOString();
      current.comparabilityWarnings.push(error instanceof Error ? error.message : String(error));
    });
    this.pending.set(record.id, promise);
    void promise;

    return record;
  }

  private async runBenchmark(id: string, sourceWorkspacePath: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    const controller = new AbortController();

    // Two independent isolated copies from the same source snapshot. Run
    // concurrently (not one-then-the-other with shared state) so neither
    // arm can observe the other's output.
    const [directWorkspace, orchestratedWorkspace] = await Promise.all([
      createTaskWorkspace(this.scratchRoot, id, "direct", sourceWorkspacePath),
      createTaskWorkspace(this.scratchRoot, id, "orchestrated", sourceWorkspacePath),
    ]);

    const [direct, orchestrated] = await Promise.all([
      this.directExecutor.run({
        workspacePath: directWorkspace.path,
        prompt: record.prompt,
        criteria: record.criteria,
        signal: controller.signal,
      }),
      this.orchestratedExecutor.run({
        workspacePath: orchestratedWorkspace.path,
        prompt: record.prompt,
        criteria: record.criteria,
        signal: controller.signal,
      }),
    ]);

    const current = this.records.get(id);
    if (!current) return;
    current.direct = direct;
    current.orchestrated = orchestrated;
    current.comparabilityWarnings = buildComparabilityWarnings(direct, orchestrated);
    current.status = "completed";
    current.completedAt = new Date().toISOString();
  }
}
