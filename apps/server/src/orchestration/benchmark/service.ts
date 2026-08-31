import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContractCriterion, ModelRole, TokenUsage } from "../contracts.js";
import { logError } from "../../error-log.js";

export type BenchmarkMode = "direct" | "orchestrated";
export type BenchmarkStatus = "running" | "completed" | "failed" | "cancelled";

export interface BenchmarkArmResult {
  executionId: string;
  success: boolean;
  verificationPassed: boolean;
  verificationSummary: string;
  modelIds: string[];
  logicalRoles: ModelRole[];
  usage: TokenUsage;
  estimatedUsd: number | null;
  wallClockMs: number;
  calls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
  outputSummary: string;
  error: string | null;
}

export interface BenchmarkRecord {
  id: string;
  agentId: string;
  snapshotHash: string;
  prompt: string;
  criteria: ContractCriterion[];
  status: BenchmarkStatus;
  direct: BenchmarkArmResult | null;
  orchestrated: BenchmarkArmResult | null;
  comparabilityWarnings: string[];
  limitations: string[];
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface BenchmarkSnapshot {
  hash: string;
  createIsolatedCopy(label: BenchmarkMode): Promise<string>;
  cleanup(): Promise<void>;
}

export interface BenchmarkWorkspacePort {
  snapshot(agentId: string, benchmarkId: string): Promise<BenchmarkSnapshot>;
}

export interface BenchmarkExecutor {
  execute(input: {
    benchmarkId: string;
    mode: BenchmarkMode;
    workspacePath: string;
    prompt: string;
    criteria: readonly ContractCriterion[];
    signal: AbortSignal;
  }): Promise<BenchmarkArmResult>;
}

interface BenchmarkDatabase { version: 1; records: BenchmarkRecord[] }

export class BenchmarkStore {
  private data: BenchmarkDatabase = { version: 1, records: [] };
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.data = JSON.parse(await readFile(this.filePath, "utf8")) as BenchmarkDatabase;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
    for (const record of this.data.records) {
      if (record.status === "running") {
        record.status = "failed";
        record.error = "Benchmark interrupted by server restart";
        record.completedAt = new Date().toISOString();
      }
    }
    await this.persist();
  }

  snapshot(): BenchmarkDatabase { return structuredClone(this.data); }

  async mutate<T>(fn: (database: BenchmarkDatabase) => T): Promise<T> {
    let result!: T;
    this.queue = this.queue.then(async () => {
      result = fn(this.data);
      await this.persist();
    });
    await this.queue;
    return structuredClone(result);
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export class BenchmarkNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(id: string) { super(`Benchmark not found: ${id}`); }
}

export class BenchmarkService {
  private readonly controllers = new Map<string, AbortController>();
  constructor(
    private readonly store: BenchmarkStore,
    private readonly workspaces: BenchmarkWorkspacePort,
    private readonly executor: BenchmarkExecutor,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async initialize(): Promise<void> { await this.store.initialize(); }

  get(id: string): BenchmarkRecord {
    const value = this.store.snapshot().records.find((record) => record.id === id);
    if (!value) throw new BenchmarkNotFoundError(id);
    return value;
  }

  async create(agentId: string, prompt: string, criteria: ContractCriterion[]): Promise<BenchmarkRecord> {
    const id = this.newId();
    const snapshot = await this.workspaces.snapshot(agentId, id);
    const record: BenchmarkRecord = {
      id, agentId, snapshotHash: snapshot.hash, prompt, criteria, status: "running",
      direct: null, orchestrated: null, comparabilityWarnings: [],
      limitations: ["Estimated cost is not billed cost.", "Results describe one prompt and snapshot, not every workload."],
      createdAt: this.now().toISOString(), completedAt: null, error: null,
    };
    await this.store.mutate((database) => { database.records.push(record); });
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.run(record, snapshot, controller.signal).finally(() => this.controllers.delete(id));
    return record;
  }

  async cancel(id: string): Promise<boolean> {
    const record = this.get(id);
    if (record.status !== "running") return false;
    this.controllers.get(id)?.abort();
    await this.store.mutate((database) => {
      const current = database.records.find((entry) => entry.id === id)!;
      if (current.status === "running") {
        current.status = "cancelled";
        current.error = "Benchmark cancelled";
        current.completedAt = this.now().toISOString();
      }
    });
    return true;
  }

  private async run(record: BenchmarkRecord, snapshot: BenchmarkSnapshot, signal: AbortSignal): Promise<void> {
    try {
      const [directPath, orchestratedPath] = await Promise.all([
        snapshot.createIsolatedCopy("direct"),
        snapshot.createIsolatedCopy("orchestrated"),
      ]);
      const [direct, orchestrated] = await Promise.all([
        this.executor.execute({ benchmarkId: record.id, mode: "direct", workspacePath: directPath, prompt: record.prompt, criteria: record.criteria, signal }),
        this.executor.execute({ benchmarkId: record.id, mode: "orchestrated", workspacePath: orchestratedPath, prompt: record.prompt, criteria: record.criteria, signal }),
      ]);
      const warnings: string[] = [];
      if (direct.modelIds.join() !== orchestrated.modelIds.join()) warnings.push("The arms used different model IDs.");
      if (direct.estimatedUsd === null || orchestrated.estimatedUsd === null) warnings.push("Pricing is not configured; cost comparison is token-only.");
      if (direct.verificationPassed !== orchestrated.verificationPassed) warnings.push("Verification quality differs; do not claim a cost winner.");
      await this.store.mutate((database) => {
        const current = database.records.find((entry) => entry.id === record.id)!;
        if (current.status === "cancelled") return;
        current.direct = direct;
        current.orchestrated = orchestrated;
        current.comparabilityWarnings = warnings;
        current.status = "completed";
        current.completedAt = this.now().toISOString();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logError("benchmark", `record ${record.id} failed: ${message}`);
      await this.store.mutate((database) => {
        const current = database.records.find((entry) => entry.id === record.id)!;
        if (current.status === "cancelled") return;
        current.status = "failed";
        current.error = message;
        current.completedAt = this.now().toISOString();
      });
    } finally {
      await snapshot.cleanup().catch(() => undefined);
    }
  }
}
