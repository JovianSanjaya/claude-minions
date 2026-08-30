import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../errors.js";
import type {
  BudgetPolicy,
  ContractCriterion,
  ModelRole,
  RoleUsage,
  SelectedExecutionMode,
  UsageLedger,
} from "../contracts.js";

/**
 * Direct-versus-orchestrated benchmark service (Task 3).
 *
 * The service owns fairness, not execution. Both arms are supplied as injected
 * `BenchmarkExecutor` ports so this module compiles and tests without the
 * control plane (Task 1) or the execution engine (Task 2). No fake executor,
 * fixture, or mock lives in this file; fakes belong to the test files.
 *
 * Fairness rules enforced here (specification 8.9):
 *   1. one source snapshot is captured, then one isolated copy per arm;
 *   2. both arms receive the same prompt and the same confirmed criteria;
 *   3. the second arm never observes the first arm's result;
 *   4. verification results are compared before any cost claim;
 *   5. model and pricing differences become explicit comparability warnings;
 *   6. a cost verdict is withheld whenever quality or verification differs;
 *   7. a direct win is a valid, fully reported outcome.
 */

export type BenchmarkArm = "direct" | "orchestrated";

export type BenchmarkStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type BenchmarkArmStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type VerificationScope =
  | "worker-visible"
  | "protected"
  | "global"
  | "manual";

export interface BenchmarkVerificationSummary {
  scope: VerificationScope;
  commandOrCheck: string;
  status: "passed" | "failed" | "skipped";
  outputSummary: string;
}

export interface BenchmarkCounters {
  modelCalls: number;
  attempts: number;
  contextExpansions: number;
  escalations: number;
  integrationFailures: number;
}

export interface BenchmarkArmResult {
  arm: BenchmarkArm;
  status: BenchmarkArmStatus;
  /** Stable execution correlation ID produced by the arm executor. */
  executionId: string | null;
  /** Route the arm actually took. `direct` arms report "direct". */
  selectedMode: SelectedExecutionMode | null;
  /** Hash of the isolated copy this arm started from. */
  startedFromSnapshotHash: string | null;
  /** Non-filesystem label for the isolated copy; never an absolute host path. */
  workspaceLabel: string | null;
  /** Verification outcome. Quality is reported before any cost number. */
  verifications: BenchmarkVerificationSummary[];
  /** True only when the arm's required verification actually passed. */
  succeeded: boolean;
  usage: UsageLedger;
  counters: BenchmarkCounters;
  wallClockMs: number;
  finalOutputSummary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export type QualityVerdict =
  | "both-passed"
  | "direct-only"
  | "orchestrated-only"
  | "neither-passed"
  | "incomplete";

export type ComparisonVerdict =
  | "direct-better"
  | "orchestrated-better"
  | "tie"
  | "not-comparable";

export type CostVerdict = ComparisonVerdict | "unknown-pricing";

export interface BenchmarkComparison {
  /** Always evaluated and rendered before token or dollar numbers. */
  qualityVerdict: QualityVerdict;
  verificationComparable: boolean;
  /** False whenever quality differs, an arm did not finish, or checks differ. */
  costComparable: boolean;
  tokenVerdict: ComparisonVerdict;
  costVerdict: CostVerdict;
  wallClockVerdict: ComparisonVerdict;
  totalTokenDelta: number | null;
  estimatedUsdDelta: number | null;
  wallClockDeltaMs: number | null;
  pricingStatus: "configured" | "unknown";
  /** Reasons a reader must not over-read the numbers. */
  warnings: string[];
  limitations: string[];
}

export interface BenchmarkRecord {
  id: string;
  agentId: string;
  prompt: string;
  criteria: ContractCriterion[];
  budget: BudgetPolicy;
  status: BenchmarkStatus;
  /** Hash of the Agent workspace at capture time; both arms copy from it. */
  sourceSnapshotHash: string | null;
  armOrder: BenchmarkArm[];
  arms: Record<BenchmarkArm, BenchmarkArmResult>;
  comparison: BenchmarkComparison | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Injected ports                                                             */
/* -------------------------------------------------------------------------- */

export interface BenchmarkAgentSummary {
  id: string;
  status: string;
  workspacePath: string;
}

/** Authoritative Agent lookup. Final Assembly binds this to `AgentService`. */
export interface BenchmarkAgentPort {
  getAgent(agentId: string): Promise<BenchmarkAgentSummary | null>;
}

/** One isolated per-arm copy of the captured source snapshot. */
export interface BenchmarkArmWorkspace {
  /** Safe evidence label, for example `bench-<id>-direct`. */
  label: string;
  /** Absolute path used by the executor only; never persisted or returned. */
  path: string;
  /** Hash of this copy. Must equal the source snapshot hash. */
  snapshotHash: string;
  dispose(): Promise<void>;
}

export interface BenchmarkSourceSnapshot {
  sourceSnapshotHash: string;
  clone(arm: BenchmarkArm): Promise<BenchmarkArmWorkspace>;
  dispose(): Promise<void>;
}

/** Captures one snapshot of an Agent workspace and clones it per arm. */
export interface BenchmarkWorkspaceProvider {
  capture(input: {
    benchmarkId: string;
    agentId: string;
    workspacePath: string;
  }): Promise<BenchmarkSourceSnapshot>;
}

export interface BenchmarkExecutorInput {
  benchmarkId: string;
  agentId: string;
  arm: BenchmarkArm;
  /** Identical for every arm. */
  prompt: string;
  /** Identical for every arm. */
  criteria: ContractCriterion[];
  budget: BudgetPolicy;
  workspace: BenchmarkArmWorkspace;
  signal: AbortSignal;
}

export interface BenchmarkExecutorResult {
  executionId: string;
  selectedMode: SelectedExecutionMode | null;
  /** The arm's own claim is not trusted for cost until verification passes. */
  succeeded: boolean;
  verifications: BenchmarkVerificationSummary[];
  usage: UsageLedger;
  counters: Partial<BenchmarkCounters>;
  finalOutputSummary?: string | null;
  /** Optional self-reported hash of the workspace the arm actually used. */
  observedWorkspaceHash?: string | null;
}

/**
 * One benchmark arm. Final Assembly supplies a direct adapter backed by
 * `AgentService.sendMessage` and an orchestrated adapter backed by Task 1's
 * control service plus Task 2's execution driver.
 */
export interface BenchmarkExecutor {
  readonly arm: BenchmarkArm;
  execute(input: BenchmarkExecutorInput): Promise<BenchmarkExecutorResult>;
  cancel?(benchmarkId: string): Promise<void>;
}

export interface BenchmarkRecordStore {
  initialize(): Promise<void>;
  get(id: string): Promise<BenchmarkRecord | null>;
  list(agentId?: string): Promise<BenchmarkRecord[]>;
  put(record: BenchmarkRecord): Promise<void>;
}

export type BudgetOverrides = {
  [K in keyof BudgetPolicy]?: BudgetPolicy[K] | undefined;
};

export interface CreateBenchmarkInput {
  prompt: string;
  criteria?: ContractCriterion[] | undefined;
  budget?: BudgetOverrides | undefined;
  notes?: string | undefined;
}

/** Ignores undefined overrides so a partial body never erases a default. */
export function mergeBudget(
  base: BudgetPolicy,
  overrides: BudgetOverrides | undefined,
): BudgetPolicy {
  const merged: BudgetPolicy = { ...base };
  if (!overrides) return merged;
  for (const key of Object.keys(overrides) as Array<keyof BudgetPolicy>) {
    const value = overrides[key];
    if (value === undefined) continue;
    // Each field is independently typed; the cast keeps the loop generic.
    (merged as unknown as Record<string, number | null>)[key] = value;
  }
  return merged;
}

export interface BenchmarkServiceOptions {
  agents: BenchmarkAgentPort;
  workspaces: BenchmarkWorkspaceProvider;
  executors: Record<BenchmarkArm, BenchmarkExecutor>;
  store?: BenchmarkRecordStore;
  defaultBudget?: BudgetPolicy;
  /** Sequential order. Recorded as a comparability limitation. */
  armOrder?: BenchmarkArm[];
  now?: () => number;
  newId?: () => string;
}

/* -------------------------------------------------------------------------- */
/* Constants and safety helpers                                               */
/* -------------------------------------------------------------------------- */

const MAX_PROMPT_CHARS = 20_000;
const MAX_CRITERIA = 60;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_ERROR_CHARS = 500;
const MAX_CHECK_LABEL_CHARS = 200;
const MAX_VERIFICATIONS_PER_ARM = 60;

export const DEFAULT_BENCHMARK_BUDGET: BudgetPolicy = {
  maxInputTokens: 400_000,
  maxOutputTokens: 120_000,
  maxEstimatedUsd: null,
  maxModelCalls: 40,
  maxSteps: 60,
  maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 2,
  maxWallClockMs: 15 * 60_000,
};

const SECRET_ASSIGNMENT =
  /((?:ark[_-]?api[_-]?key|api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|secret|password|passwd|credential)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?\S+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9._-]{12,}\b/gi;

/** Bounded, secret-scrubbed text. Applied before persistence, not only on render. */
export function redactAndBound(value: string, limit: number): string {
  const scrubbed = value
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(OPENAI_STYLE_KEY, "[redacted]");
  return scrubbed.length > limit
    ? scrubbed.slice(0, limit) + "… [truncated]"
    : scrubbed;
}

function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return redactAndBound(message, MAX_ERROR_CHARS);
}

export function emptyUsageLedger(): UsageLedger {
  return {
    byRole: {},
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedUsd: null,
    pricingStatus: "unknown",
  };
}

function emptyCounters(): BenchmarkCounters {
  return {
    modelCalls: 0,
    attempts: 0,
    contextExpansions: 0,
    escalations: 0,
    integrationFailures: 0,
  };
}

function queuedArm(arm: BenchmarkArm): BenchmarkArmResult {
  return {
    arm,
    status: "queued",
    executionId: null,
    selectedMode: null,
    startedFromSnapshotHash: null,
    workspaceLabel: null,
    verifications: [],
    succeeded: false,
    usage: emptyUsageLedger(),
    counters: emptyCounters(),
    wallClockMs: 0,
    finalOutputSummary: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

function normalizeUsage(usage: UsageLedger | undefined): UsageLedger {
  if (!usage) return emptyUsageLedger();
  const byRole: Partial<Record<ModelRole, RoleUsage>> = {};
  for (const [role, entry] of Object.entries(usage.byRole ?? {})) {
    if (!entry) continue;
    byRole[role as ModelRole] = {
      modelId: redactAndBound(String(entry.modelId ?? "unknown"), 200),
      inputTokens: finite(entry.inputTokens),
      cachedInputTokens: finite(entry.cachedInputTokens),
      outputTokens: finite(entry.outputTokens),
      estimatedUsd:
        typeof entry.estimatedUsd === "number" && Number.isFinite(entry.estimatedUsd)
          ? entry.estimatedUsd
          : null,
      modelCalls: finite(entry.modelCalls),
    };
  }
  const pricingStatus = usage.pricingStatus === "configured" ? "configured" : "unknown";
  return {
    byRole,
    totalInputTokens: finite(usage.totalInputTokens),
    totalCachedInputTokens: finite(usage.totalCachedInputTokens),
    totalOutputTokens: finite(usage.totalOutputTokens),
    totalEstimatedUsd:
      pricingStatus === "configured" &&
      typeof usage.totalEstimatedUsd === "number" &&
      Number.isFinite(usage.totalEstimatedUsd)
        ? usage.totalEstimatedUsd
        : null,
    pricingStatus,
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

function normalizeVerifications(
  input: BenchmarkVerificationSummary[] | undefined,
): BenchmarkVerificationSummary[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_VERIFICATIONS_PER_ARM).map((record) => ({
    scope: record.scope,
    commandOrCheck: redactAndBound(String(record.commandOrCheck ?? ""), MAX_CHECK_LABEL_CHARS),
    status: record.status,
    outputSummary: redactAndBound(String(record.outputSummary ?? ""), MAX_SUMMARY_CHARS),
  }));
}

function totalTokens(usage: UsageLedger): number {
  return usage.totalInputTokens + usage.totalOutputTokens;
}

/**
 * A benchmark arm counts as a quality pass only when the executor claims
 * success AND no trusted (protected/global) check failed. A worker's claim is
 * never sufficient on its own.
 */
export function armPassedQuality(arm: BenchmarkArmResult): boolean {
  if (arm.status !== "succeeded" || !arm.succeeded) return false;
  return !arm.verifications.some(
    (record) =>
      record.status === "failed" &&
      (record.scope === "protected" || record.scope === "global"),
  );
}

function checkSignature(arm: BenchmarkArmResult): string {
  return arm.verifications
    .filter((record) => record.scope === "protected" || record.scope === "global")
    .map((record) => record.scope + ":" + record.commandOrCheck)
    .sort()
    .join("|");
}

function modelSignature(usage: UsageLedger): string {
  return Object.entries(usage.byRole)
    .map(([role, entry]) => role + "=" + (entry ? entry.modelId : "none"))
    .sort()
    .join(",");
}

function verdictFromLower(
  directValue: number,
  orchestratedValue: number,
): ComparisonVerdict {
  if (directValue === orchestratedValue) return "tie";
  return directValue < orchestratedValue ? "direct-better" : "orchestrated-better";
}

/**
 * Quality first, cost second. This function is the single place that decides
 * whether a cost claim is allowed at all.
 */
export function compareArms(
  direct: BenchmarkArmResult,
  orchestrated: BenchmarkArmResult,
  extraLimitations: string[] = [],
): BenchmarkComparison {
  const warnings: string[] = [];
  const limitations = [
    "One sample per arm. Model sampling variance is not measured.",
    "Arms run sequentially on the same host, so wall-clock time is indicative only.",
    ...extraLimitations,
  ];

  const directPassed = armPassedQuality(direct);
  const orchestratedPassed = armPassedQuality(orchestrated);
  const bothFinished =
    (direct.status === "succeeded" || direct.status === "failed") &&
    (orchestrated.status === "succeeded" || orchestrated.status === "failed");

  let qualityVerdict: QualityVerdict;
  if (!bothFinished) {
    qualityVerdict = "incomplete";
  } else if (directPassed && orchestratedPassed) {
    qualityVerdict = "both-passed";
  } else if (directPassed) {
    qualityVerdict = "direct-only";
  } else if (orchestratedPassed) {
    qualityVerdict = "orchestrated-only";
  } else {
    qualityVerdict = "neither-passed";
  }

  const verificationComparable =
    checkSignature(direct) === checkSignature(orchestrated) &&
    checkSignature(direct).length > 0;
  if (!verificationComparable) {
    warnings.push(
      "The trusted (protected/global) checks recorded for the two arms are not identical, so verification quality is not directly comparable.",
    );
  }

  if (direct.status === "cancelled" || orchestrated.status === "cancelled") {
    warnings.push("At least one arm was cancelled; results are partial.");
  }
  if (direct.error) warnings.push("Direct arm error: " + direct.error);
  if (orchestrated.error) warnings.push("Orchestrated arm error: " + orchestrated.error);

  if (
    direct.startedFromSnapshotHash &&
    orchestrated.startedFromSnapshotHash &&
    direct.startedFromSnapshotHash !== orchestrated.startedFromSnapshotHash
  ) {
    warnings.push(
      "The two arms did not start from an identical workspace snapshot; the comparison is invalid.",
    );
  }

  const directModels = modelSignature(direct.usage);
  const orchestratedModels = modelSignature(orchestrated.usage);
  if (directModels !== orchestratedModels) {
    warnings.push(
      "Arms used different logical role or model assignments (direct: " +
        (directModels || "none recorded") +
        "; orchestrated: " +
        (orchestratedModels || "none recorded") +
        "). Token and cost differences partly reflect model choice.",
    );
  }

  const pricingStatus: "configured" | "unknown" =
    direct.usage.pricingStatus === "configured" &&
    orchestrated.usage.pricingStatus === "configured"
      ? "configured"
      : "unknown";
  if (pricingStatus === "unknown") {
    warnings.push(
      "Pricing is not configured for at least one arm. Token totals are reported; estimated dollars are unknown.",
    );
  }

  const qualityEqual = qualityVerdict === "both-passed" || qualityVerdict === "neither-passed";
  const costComparable =
    qualityVerdict === "both-passed" && verificationComparable && bothFinished;
  if (!costComparable) {
    warnings.push(
      qualityEqual
        ? "Cost comparison withheld: the arms are not verified-equivalent."
        : "Cost comparison withheld: the arms did not reach the same verified quality, so a cheaper arm is not a better arm.",
    );
  }

  const directTokens = totalTokens(direct.usage);
  const orchestratedTokens = totalTokens(orchestrated.usage);

  const tokenVerdict: ComparisonVerdict = costComparable
    ? verdictFromLower(directTokens, orchestratedTokens)
    : "not-comparable";

  let costVerdict: CostVerdict = "not-comparable";
  let estimatedUsdDelta: number | null = null;
  if (costComparable) {
    if (
      pricingStatus === "configured" &&
      typeof direct.usage.totalEstimatedUsd === "number" &&
      typeof orchestrated.usage.totalEstimatedUsd === "number"
    ) {
      estimatedUsdDelta =
        orchestrated.usage.totalEstimatedUsd - direct.usage.totalEstimatedUsd;
      costVerdict = verdictFromLower(
        direct.usage.totalEstimatedUsd,
        orchestrated.usage.totalEstimatedUsd,
      );
    } else {
      costVerdict = "unknown-pricing";
    }
  }

  return {
    qualityVerdict,
    verificationComparable,
    costComparable,
    tokenVerdict,
    costVerdict,
    wallClockVerdict: bothFinished
      ? verdictFromLower(direct.wallClockMs, orchestrated.wallClockMs)
      : "not-comparable",
    totalTokenDelta: bothFinished ? orchestratedTokens - directTokens : null,
    estimatedUsdDelta,
    wallClockDeltaMs: bothFinished
      ? orchestrated.wallClockMs - direct.wallClockMs
      : null,
    pricingStatus,
    warnings,
    limitations,
  };
}

/* -------------------------------------------------------------------------- */
/* Stores                                                                     */
/* -------------------------------------------------------------------------- */

export class InMemoryBenchmarkStore implements BenchmarkRecordStore {
  private readonly records = new Map<string, BenchmarkRecord>();

  async initialize(): Promise<void> {}

  async get(id: string): Promise<BenchmarkRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(agentId?: string): Promise<BenchmarkRecord[]> {
    return [...this.records.values()]
      .filter((record) => !agentId || record.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record));
  }

  async put(record: BenchmarkRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
}

interface BenchmarkFile {
  version: 1;
  benchmarks: BenchmarkRecord[];
}

/**
 * Single-process JSON persistence for benchmark records. It mirrors the
 * baseline `JsonStore` conventions: serialized mutations, a mode-0600
 * temporary file, and an atomic rename. Multi-process execution would need a
 * real database; that is documented as a production evolution, not built here.
 */
export class FileBenchmarkStore implements BenchmarkRecordStore {
  private data: BenchmarkFile = { version: 1, benchmarks: [] };
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BenchmarkFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.benchmarks)) {
        throw new Error("Unsupported benchmark database format");
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.data);
    }
    // A benchmark cannot survive a restart: reconcile, never claim success.
    let dirty = false;
    for (const record of this.data.benchmarks) {
      if (record.status !== "running") continue;
      dirty = true;
      record.status = "cancelled";
      record.error = "Server restarted while this benchmark was active";
      record.completedAt = new Date().toISOString();
      for (const arm of ["direct", "orchestrated"] as BenchmarkArm[]) {
        const armRecord = record.arms[arm];
        if (armRecord.status === "queued" || armRecord.status === "running") {
          armRecord.status = "cancelled";
          armRecord.error = "Server restarted while this arm was active";
        }
      }
      record.comparison = compareArms(record.arms.direct, record.arms.orchestrated, [
        "Benchmark interrupted by a server restart.",
      ]);
    }
    if (dirty) await this.persist(this.data);
  }

  async get(id: string): Promise<BenchmarkRecord | null> {
    const record = this.data.benchmarks.find((item) => item.id === id);
    return record ? structuredClone(record) : null;
  }

  async list(agentId?: string): Promise<BenchmarkRecord[]> {
    return this.data.benchmarks
      .filter((record) => !agentId || record.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => structuredClone(record));
  }

  async put(record: BenchmarkRecord): Promise<void> {
    const operation = this.queue.then(async () => {
      const next: BenchmarkFile = {
        version: 1,
        benchmarks: this.data.benchmarks.filter((item) => item.id !== record.id),
      };
      next.benchmarks.push(structuredClone(record));
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private async persist(data: BenchmarkFile): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

/* -------------------------------------------------------------------------- */
/* Real filesystem snapshot provider                                          */
/* -------------------------------------------------------------------------- */

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".codex",
  ".orchestration",
]);

function isExcludedEntry(name: string): boolean {
  return SNAPSHOT_EXCLUDES.has(name) || name.startsWith(".env");
}

/** Deterministic content hash of a directory tree, used as the snapshot ID. */
export async function hashDirectory(root: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (directory: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const sorted = entries
      .filter((entry) => !isExcludedEntry(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of sorted) {
      const relativePath = relative ? relative + "/" + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        digest.update("L " + relativePath + " ");
        continue;
      }
      if (entry.isDirectory()) {
        digest.update("D " + relativePath + " ");
        await walk(absolute, relativePath);
      } else if (entry.isFile()) {
        const contents = await readFile(absolute);
        digest.update(
          "F " +
            relativePath +
            " " +
            createHash("sha256").update(contents).digest("hex") +
            " ",
        );
      }
    }
  };
  await walk(root, "");
  return digest.digest("hex");
}

/**
 * Copies the Agent workspace once into a benchmark-specific temporary root and
 * then makes one isolated copy per arm. Cleanup only ever targets the resolved
 * benchmark-specific directory, never a workspace root or a broad glob.
 */
export class FileSystemBenchmarkWorkspaceProvider
  implements BenchmarkWorkspaceProvider
{
  constructor(
    private readonly temporaryRoot: string,
    private readonly retainForDebugging = false,
  ) {}

  async capture(input: {
    benchmarkId: string;
    agentId: string;
    workspacePath: string;
  }): Promise<BenchmarkSourceSnapshot> {
    const safeId = input.benchmarkId.replace(/[^A-Za-z0-9_-]/g, "");
    if (safeId.length < 8) {
      throw new HttpError(400, "Invalid benchmark identifier");
    }
    const root = path.resolve(this.temporaryRoot, "benchmark-" + safeId);
    const resolvedTemporaryRoot = path.resolve(this.temporaryRoot);
    if (!root.startsWith(resolvedTemporaryRoot + path.sep)) {
      throw new HttpError(400, "Benchmark workspace path escaped the temporary root");
    }
    await mkdir(root, { recursive: true });
    const sourcePath = path.join(root, "source");
    await cp(path.resolve(input.workspacePath), sourcePath, {
      recursive: true,
      dereference: false,
      filter: (source) => !isExcludedEntry(path.basename(source)),
    });
    const sourceSnapshotHash = await hashDirectory(sourcePath);
    const retain = this.retainForDebugging;
    const clones: BenchmarkArmWorkspace[] = [];

    return {
      sourceSnapshotHash,
      clone: async (arm: BenchmarkArm): Promise<BenchmarkArmWorkspace> => {
        const armPath = path.join(root, "arm-" + arm);
        await cp(sourcePath, armPath, { recursive: true, dereference: false });
        const snapshotHash = await hashDirectory(armPath);
        const workspace: BenchmarkArmWorkspace = {
          label: "benchmark-" + safeId + "/arm-" + arm,
          path: armPath,
          snapshotHash,
          dispose: async () => {
            if (retain) return;
            await rm(armPath, { recursive: true, force: true });
          },
        };
        clones.push(workspace);
        return workspace;
      },
      dispose: async () => {
        if (retain) return;
        await rm(root, { recursive: true, force: true });
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export class BenchmarkService {
  private readonly store: BenchmarkRecordStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly defaultBudget: BudgetPolicy;
  private readonly armOrder: BenchmarkArm[];
  private readonly running = new Map<string, AbortController>();
  private readonly settled = new Map<string, Promise<BenchmarkRecord>>();

  constructor(private readonly options: BenchmarkServiceOptions) {
    this.store = options.store ?? new InMemoryBenchmarkStore();
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
    this.defaultBudget = options.defaultBudget ?? DEFAULT_BENCHMARK_BUDGET;
    this.armOrder = options.armOrder ?? ["direct", "orchestrated"];
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async get(id: string): Promise<BenchmarkRecord | null> {
    return this.store.get(id);
  }

  async list(agentId: string): Promise<BenchmarkRecord[]> {
    return this.store.list(agentId);
  }

  /** Resolves when the benchmark reaches a terminal state. Used by tests and demos. */
  async whenSettled(id: string): Promise<BenchmarkRecord> {
    const pending = this.settled.get(id);
    if (pending) return pending;
    const record = await this.store.get(id);
    if (!record) throw new HttpError(404, "Benchmark not found");
    return record;
  }

  async create(agentId: string, input: CreateBenchmarkInput): Promise<BenchmarkRecord> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new HttpError(400, "A benchmark prompt is required");
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpError(400, "The benchmark prompt is too long");
    }
    const agent = await this.options.agents.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before running a benchmark");
    }
    if (agent.status === "busy") {
      throw new HttpError(409, "This Agent is already running work");
    }
    const active = (await this.store.list(agentId)).find(
      (record) => record.status === "running",
    );
    if (active) {
      throw new HttpError(409, "A benchmark is already running for this Agent");
    }

    const criteria = (input.criteria ?? []).slice(0, MAX_CRITERIA).map((criterion) => ({
      id: String(criterion.id),
      kind: criterion.kind,
      description: redactAndBound(String(criterion.description), MAX_SUMMARY_CHARS),
      verification: criterion.verification,
    }));

    const record: BenchmarkRecord = {
      id: this.newId(),
      agentId,
      prompt: redactAndBound(prompt, MAX_PROMPT_CHARS),
      criteria,
      budget: mergeBudget(this.defaultBudget, input.budget),
      status: "running",
      sourceSnapshotHash: null,
      armOrder: [...this.armOrder],
      arms: {
        direct: queuedArm("direct"),
        orchestrated: queuedArm("orchestrated"),
      },
      comparison: null,
      error: null,
      createdAt: new Date(this.now()).toISOString(),
      completedAt: null,
    };
    await this.store.put(record);

    const controller = new AbortController();
    this.running.set(record.id, controller);
    const execution = this.run(record, agent, controller)
      .catch(async (reason) => {
        const failed = (await this.store.get(record.id)) ?? record;
        failed.status = "failed";
        failed.error = errorText(reason);
        failed.completedAt = new Date(this.now()).toISOString();
        failed.comparison = compareArms(failed.arms.direct, failed.arms.orchestrated, [
          "Benchmark aborted before both arms completed.",
        ]);
        await this.store.put(failed);
        return failed;
      })
      .finally(() => {
        this.running.delete(record.id);
      });
    this.settled.set(record.id, execution);
    void execution.catch(() => undefined);
    return structuredClone(record);
  }

  async cancel(id: string): Promise<BenchmarkRecord> {
    const record = await this.store.get(id);
    if (!record) throw new HttpError(404, "Benchmark not found");
    const controller = this.running.get(id);
    if (controller) controller.abort();
    for (const arm of this.armOrder) {
      await this.options.executors[arm].cancel?.(id);
    }
    const pending = this.settled.get(id);
    if (pending) {
      await pending.catch(() => undefined);
    }
    return (await this.store.get(id)) ?? record;
  }

  private async run(
    initial: BenchmarkRecord,
    agent: BenchmarkAgentSummary,
    controller: AbortController,
  ): Promise<BenchmarkRecord> {
    let record = structuredClone(initial);
    const extraLimitations: string[] = [];
    const snapshot = await this.options.workspaces.capture({
      benchmarkId: record.id,
      agentId: agent.id,
      workspacePath: agent.workspacePath,
    });
    record.sourceSnapshotHash = snapshot.sourceSnapshotHash;
    await this.store.put(record);

    const disposables: BenchmarkArmWorkspace[] = [];
    try {
      for (const arm of record.armOrder) {
        // Arm inputs are built only from the immutable benchmark record, never
        // from another arm's result. Nothing produced by a previous arm is in
        // scope here, which is what keeps the second arm blind to the first.
        const armResult = await this.runArm(record, arm, snapshot, controller, disposables);
        record.arms[arm] = armResult;
        await this.store.put(record);
        if (armResult.status === "cancelled") break;
      }
    } finally {
      for (const workspace of disposables) {
        await workspace.dispose().catch(() => undefined);
      }
      await snapshot.dispose().catch(() => undefined);
    }

    for (const arm of ["direct", "orchestrated"] as BenchmarkArm[]) {
      const armRecord = record.arms[arm];
      if (armRecord.status === "queued") {
        armRecord.status = "skipped";
        armRecord.error = "Arm did not run because the benchmark ended early";
      }
      if (
        armRecord.startedFromSnapshotHash &&
        record.sourceSnapshotHash &&
        armRecord.startedFromSnapshotHash !== record.sourceSnapshotHash
      ) {
        extraLimitations.push(
          "The " + arm + " arm copy did not hash-match the captured source snapshot.",
        );
      }
    }

    const cancelled = controller.signal.aborted;
    record.status = cancelled
      ? "cancelled"
      : record.arms.direct.status === "skipped" ||
          record.arms.orchestrated.status === "skipped"
        ? "failed"
        : "completed";
    if (cancelled) record.error = record.error ?? "Benchmark cancelled";
    record.comparison = compareArms(
      record.arms.direct,
      record.arms.orchestrated,
      extraLimitations,
    );
    record.completedAt = new Date(this.now()).toISOString();
    await this.store.put(record);
    record = (await this.store.get(record.id)) ?? record;
    return record;
  }

  private async runArm(
    record: BenchmarkRecord,
    arm: BenchmarkArm,
    snapshot: BenchmarkSourceSnapshot,
    controller: AbortController,
    disposables: BenchmarkArmWorkspace[],
  ): Promise<BenchmarkArmResult> {
    const result = queuedArm(arm);
    const startedAtMs = this.now();
    result.startedAt = new Date(startedAtMs).toISOString();

    if (controller.signal.aborted) {
      result.status = "cancelled";
      result.error = "Benchmark cancelled before this arm started";
      result.completedAt = new Date(this.now()).toISOString();
      return result;
    }

    let workspace: BenchmarkArmWorkspace;
    try {
      workspace = await snapshot.clone(arm);
    } catch (reason) {
      result.status = "failed";
      result.error = errorText(reason);
      result.completedAt = new Date(this.now()).toISOString();
      result.wallClockMs = Math.max(0, this.now() - startedAtMs);
      return result;
    }
    disposables.push(workspace);
    result.status = "running";
    result.workspaceLabel = workspace.label;
    result.startedFromSnapshotHash = workspace.snapshotHash;

    try {
      const executed = await this.options.executors[arm].execute({
        benchmarkId: record.id,
        agentId: record.agentId,
        arm,
        // Identical inputs, cloned so one arm cannot mutate the other's copy.
        prompt: record.prompt,
        criteria: structuredClone(record.criteria),
        budget: structuredClone(record.budget),
        workspace,
        signal: controller.signal,
      });
      result.executionId = redactAndBound(String(executed.executionId ?? ""), 200) || null;
      result.selectedMode = executed.selectedMode ?? null;
      result.usage = normalizeUsage(executed.usage);
      result.verifications = normalizeVerifications(executed.verifications);
      result.counters = { ...emptyCounters(), ...(executed.counters ?? {}) };
      result.finalOutputSummary = executed.finalOutputSummary
        ? redactAndBound(String(executed.finalOutputSummary), MAX_SUMMARY_CHARS)
        : null;
      if (
        executed.observedWorkspaceHash &&
        executed.observedWorkspaceHash !== workspace.snapshotHash
      ) {
        result.error =
          "The arm reported a workspace hash that differs from its isolated copy";
      }
      result.succeeded = executed.succeeded === true;
      result.status = controller.signal.aborted
        ? "cancelled"
        : result.succeeded
          ? "succeeded"
          : "failed";
      if (!result.succeeded && !result.error) {
        result.error = "The arm did not report a verified success";
      }
    } catch (reason) {
      result.status = controller.signal.aborted ? "cancelled" : "failed";
      result.error = errorText(reason);
      result.succeeded = false;
    }

    result.wallClockMs = Math.max(0, this.now() - startedAtMs);
    result.completedAt = new Date(this.now()).toISOString();
    return result;
  }
}
