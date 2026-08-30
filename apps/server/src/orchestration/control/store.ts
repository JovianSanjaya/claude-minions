import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ApplicationMapSummary,
  ContextPacketSummary,
  ContractAmendment,
  ExecutionContract,
  IntentDraft,
  ModelRole,
  Orchestration,
  OrchestrationEvent,
  OrchestrationTask,
  SelectedExecutionMode,
  SharedArtifact,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { redactRecord } from "./redaction.js";

/**
 * Single-process orchestration database.
 *
 * Deliberately separate from the baseline `launchpad.json` so orchestration
 * data cannot corrupt or block Agent CRUD. Mirrors the baseline
 * {@link ../../store.ts | JsonStore} pattern: a serialized mutation queue,
 * mode-0600 temporary writes and an atomic rename.
 *
 * PostgreSQL with row-level leases is the production evolution for
 * multi-process execution; it is deliberately out of scope for this POC.
 */

export const ORCHESTRATION_SCHEMA_VERSION = 1;

/** Control-plane-private record of a plan produced by the driver. */
export interface OrchestrationPlanRecord {
  orchestrationId: string;
  selectedMode: SelectedExecutionMode;
  routeReason: string;
  applicationMapVersion: number;
  taskIds: string[];
  createdAt: string;
}

/** An open or settled budget reservation for one model call. */
export interface BudgetReservationRecord {
  id: string;
  orchestrationId: string;
  taskId: string | null;
  executionId: string;
  role: ModelRole;
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  status: "open" | "committed" | "released";
  createdAt: string;
  settledAt: string | null;
}

/** Per-orchestration counters that the frozen `Orchestration` type has no room for. */
export interface BudgetState {
  orchestrationId: string;
  modelCalls: number;
  steps: number;
  workerAttemptsByTask: Record<string, number>;
  contextExpansionsByTask: Record<string, number>;
  reservations: BudgetReservationRecord[];
  wallClockStartedAt: string | null;
  exhaustedReason: string | null;
}

/**
 * Placeholder collection so Task 3's benchmark records can be correlated with
 * orchestrations after Final Assembly without another schema migration.
 */
export interface BenchmarkReference {
  id: string;
  agentId: string;
  directOrchestrationId: string | null;
  orchestratedOrchestrationId: string | null;
  note: string;
  createdAt: string;
}

/** Metadata describing what happened to a temporary worker workspace. */
export interface WorkspaceDisposition {
  orchestrationId: string;
  taskId: string | null;
  policy: "cleaned" | "archived" | "retained-for-debugging" | "unknown";
  location: string | null;
  reason: string;
  recordedAt: string;
}

export interface OrchestrationDatabase {
  version: number;
  orchestrations: Orchestration[];
  intentDrafts: IntentDraft[];
  contracts: ExecutionContract[];
  amendments: ContractAmendment[];
  plans: OrchestrationPlanRecord[];
  tasks: OrchestrationTask[];
  applicationMaps: ApplicationMapSummary[];
  contextPackets: ContextPacketSummary[];
  attempts: WorkerAttempt[];
  artifacts: SharedArtifact[];
  verifications: VerificationRecord[];
  events: OrchestrationEvent[];
  budgetStates: BudgetState[];
  workspaceDispositions: WorkspaceDisposition[];
  benchmarks: BenchmarkReference[];
}

export function emptyOrchestrationDatabase(): OrchestrationDatabase {
  return {
    version: ORCHESTRATION_SCHEMA_VERSION,
    orchestrations: [],
    intentDrafts: [],
    contracts: [],
    amendments: [],
    plans: [],
    tasks: [],
    applicationMaps: [],
    contextPackets: [],
    attempts: [],
    artifacts: [],
    verifications: [],
    events: [],
    budgetStates: [],
    workspaceDispositions: [],
    benchmarks: [],
  };
}

const isoString = z.string().min(1).max(64);
const count = z.number().finite().min(0);
const text = z.string();

const tokenUsageSchema = z.object({
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
});

const roleSchema = z.enum(["planner", "worker", "verifier", "integrator"]);

const roleUsageSchema = z.object({
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
  modelId: text,
  estimatedUsd: z.number().finite().nullable(),
  modelCalls: count,
});

const usageLedgerSchema = z.object({
  byRole: z.record(z.string(), roleUsageSchema),
  totalInputTokens: count,
  totalCachedInputTokens: count,
  totalOutputTokens: count,
  totalEstimatedUsd: z.number().finite().nullable(),
  pricingStatus: z.enum(["configured", "unknown"]),
});

const budgetPolicySchema = z.object({
  maxInputTokens: z.number().finite().min(0).nullable(),
  maxOutputTokens: z.number().finite().min(0).nullable(),
  maxEstimatedUsd: z.number().finite().min(0).nullable(),
  maxModelCalls: count,
  maxSteps: count,
  maxWorkerAttempts: count,
  maxContextExpansionsPerTask: count,
  maxWallClockMs: count,
});

const costEstimateSchema = z.object({
  inputTokenLow: count,
  inputTokenHigh: count,
  outputTokenLow: count,
  outputTokenHigh: count,
  estimatedUsdLow: z.number().finite().min(0).nullable(),
  estimatedUsdHigh: z.number().finite().min(0).nullable(),
  pricingStatus: z.enum(["configured", "unknown"]),
  assumptions: z.array(text),
});

const intentDraftSchema = z.object({
  id: text,
  orchestrationId: text,
  revision: count,
  goal: text,
  requirements: z.array(text),
  assumptions: z.array(text),
  nonGoals: z.array(text),
  architectureDecisions: z.array(text),
  materialQuestions: z.array(text),
  manualExpectations: z.array(text),
  createdAt: isoString,
});

const criterionSchema = z.object({
  id: text,
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: text,
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
});

const contractSchema = z.object({
  id: text,
  orchestrationId: text,
  version: count,
  intent: intentDraftSchema,
  criteria: z.array(criterionSchema),
  confirmedBy: z.literal("user"),
  confirmedAt: isoString,
  supersedesContractId: text.nullable(),
});

const amendmentSchema = z.object({
  id: text,
  orchestrationId: text,
  baseContractId: text,
  proposedIntent: intentDraftSchema,
  proposedCriteria: z.array(criterionSchema).nullable(),
  reason: text,
  material: z.boolean(),
  status: z.enum(["pending", "confirmed", "rejected"]),
  createdAt: isoString,
  decidedAt: isoString.nullable(),
});

const orchestrationSchema = z.object({
  id: text,
  agentId: text,
  prompt: text,
  requestedMode: z.enum(["auto", "direct", "orchestrated"]),
  selectedMode: z.enum(["direct", "one-worker", "multi-worker"]).nullable(),
  status: z.enum([
    "drafting-intent",
    "awaiting-confirmation",
    "planning",
    "ready",
    "running",
    "integrating",
    "verifying",
    "needs-user",
    "budget-exhausted",
    "completed",
    "failed",
    "cancelled",
  ]),
  currentIntentDraftId: text.nullable(),
  activeContractId: text.nullable(),
  estimate: costEstimateSchema.nullable(),
  budget: budgetPolicySchema,
  usage: usageLedgerSchema,
  finalOutput: text.nullable(),
  error: text.nullable(),
  createdAt: isoString,
  updatedAt: isoString,
  completedAt: isoString.nullable(),
});

const taskSchema = z.object({
  id: text,
  orchestrationId: text,
  title: text,
  objective: text,
  status: z.enum([
    "blocked",
    "ready",
    "preflight",
    "running",
    "verifying",
    "stale",
    "passed",
    "failed",
    "cancelled",
  ]),
  dependsOn: z.array(text),
  allowedPaths: z.array(text),
  acceptanceCriterionIds: z.array(text),
  requiredArtifactIds: z.array(text),
  observedArtifactVersions: z.record(text, z.number().finite()),
  applicationMapVersion: count,
  attemptCount: count,
});

const applicationMapSchema = z.object({
  orchestrationId: text,
  version: count,
  repositoryHash: text,
  summary: text,
  fileCount: count,
  createdAt: isoString,
});

const contextPacketSchema = z.object({
  taskId: text,
  applicationMapVersion: count,
  contractVersion: count,
  sourceFiles: z.array(
    z.object({ path: text, sha256: text, bytes: count }),
  ),
  relevantInterfaces: z.array(text),
  artifactVersions: z.record(text, z.number().finite()),
  estimatedTokens: count,
});

const artifactSchema = z.object({
  id: text,
  orchestrationId: text,
  producerTaskId: text,
  kind: z.enum(["api", "interface", "schema", "decision", "manifest", "test-result"]),
  name: text,
  version: count,
  payload: text,
  createdAt: isoString,
});

const attemptSchema = z.object({
  id: text,
  orchestrationId: text,
  taskId: text,
  number: count,
  executionId: text,
  modelId: text,
  contextFileHashes: z.array(text),
  changedFiles: z.array(text),
  status: z.enum(["running", "passed", "failed", "cancelled"]),
  usage: tokenUsageSchema,
  errorSummary: text.nullable(),
  createdAt: isoString,
  completedAt: isoString.nullable(),
});

const verificationSchema = z.object({
  id: text,
  orchestrationId: text,
  taskId: text.nullable(),
  scope: z.enum(["worker-visible", "protected", "global", "manual"]),
  commandOrCheck: text,
  status: z.enum(["passed", "failed", "skipped"]),
  outputSummary: text,
  startedAt: isoString,
  completedAt: isoString,
});

const eventSchema = z.object({
  id: text,
  orchestrationId: text,
  taskId: text.nullable(),
  executionId: text.nullable(),
  type: text,
  actorRole: z.enum([
    "user",
    "planner",
    "worker",
    "verifier",
    "integrator",
    "control-plane",
    "runtime",
  ]),
  modelId: text.nullable(),
  summary: text,
  metadata: z.record(
    text,
    z.union([text, z.number().finite(), z.boolean(), z.null()]),
  ),
  createdAt: isoString,
});

const planRecordSchema = z.object({
  orchestrationId: text,
  selectedMode: z.enum(["direct", "one-worker", "multi-worker"]),
  routeReason: text,
  applicationMapVersion: count,
  taskIds: z.array(text),
  createdAt: isoString,
});

const reservationSchema = z.object({
  id: text,
  orchestrationId: text,
  taskId: text.nullable(),
  executionId: text,
  role: roleSchema,
  modelId: text,
  estimatedInputTokens: count,
  estimatedOutputTokens: count,
  status: z.enum(["open", "committed", "released"]),
  createdAt: isoString,
  settledAt: isoString.nullable(),
});

const budgetStateSchema = z.object({
  orchestrationId: text,
  modelCalls: count,
  steps: count,
  workerAttemptsByTask: z.record(text, z.number().finite()),
  contextExpansionsByTask: z.record(text, z.number().finite()),
  reservations: z.array(reservationSchema),
  wallClockStartedAt: isoString.nullable(),
  exhaustedReason: text.nullable(),
});

const workspaceDispositionSchema = z.object({
  orchestrationId: text,
  taskId: text.nullable(),
  policy: z.enum(["cleaned", "archived", "retained-for-debugging", "unknown"]),
  location: text.nullable(),
  reason: text,
  recordedAt: isoString,
});

const benchmarkReferenceSchema = z.object({
  id: text,
  agentId: text,
  directOrchestrationId: text.nullable(),
  orchestratedOrchestrationId: text.nullable(),
  note: text,
  createdAt: isoString,
});

const databaseSchema = z.object({
  version: z.number().int(),
  orchestrations: z.array(orchestrationSchema),
  intentDrafts: z.array(intentDraftSchema),
  contracts: z.array(contractSchema),
  amendments: z.array(amendmentSchema),
  plans: z.array(planRecordSchema),
  tasks: z.array(taskSchema),
  applicationMaps: z.array(applicationMapSchema),
  contextPackets: z.array(contextPacketSchema),
  attempts: z.array(attemptSchema),
  artifacts: z.array(artifactSchema),
  verifications: z.array(verificationSchema),
  events: z.array(eventSchema),
  budgetStates: z.array(budgetStateSchema),
  workspaceDispositions: z.array(workspaceDispositionSchema),
  benchmarks: z.array(benchmarkReferenceSchema),
});

/** Thrown when the persisted database cannot be trusted. */
export class OrchestrationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationStoreError";
  }
}

export class OrchestrationStore {
  private data: OrchestrationDatabase = emptyOrchestrationDatabase();
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly filePath: string) {}

  get databasePath(): string {
    return this.filePath;
  }

  /**
   * Loads the database, creating a deterministic empty one when absent.
   * Rejects corrupted content and any schema version this build does not
   * understand instead of silently discarding evidence.
   */
  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.data = emptyOrchestrationDatabase();
      await this.persist(this.data);
      this.initialized = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new OrchestrationStoreError(
        "Orchestration database at " + this.filePath + " is not valid JSON",
      );
    }

    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new OrchestrationStoreError(
        "Orchestration database is missing a numeric schema version",
      );
    }
    if (version > ORCHESTRATION_SCHEMA_VERSION) {
      throw new OrchestrationStoreError(
        "Orchestration database schema version " +
          version +
          " is newer than this build supports (" +
          ORCHESTRATION_SCHEMA_VERSION +
          ")",
      );
    }
    if (version < ORCHESTRATION_SCHEMA_VERSION) {
      throw new OrchestrationStoreError(
        "Orchestration database schema version " +
          version +
          " is not supported; no migration is defined",
      );
    }

    const result = databaseSchema.safeParse(parsed);
    if (!result.success) {
      throw new OrchestrationStoreError(
        "Orchestration database failed validation: " +
          result.error.issues
            .slice(0, 5)
            .map((issue) => issue.path.join(".") + " " + issue.message)
            .join("; "),
      );
    }
    this.data = result.data as OrchestrationDatabase;
    this.initialized = true;
  }

  /** Returns a defensive clone; callers may mutate it freely. */
  snapshot(): OrchestrationDatabase {
    return structuredClone(this.data);
  }

  /**
   * Serializes every mutation. The mutation runs against a clone; the clone is
   * redacted, persisted, and only then promoted to the in-memory state, so a
   * failed write leaves the previous consistent state intact.
   */
  async mutate<T>(
    mutation: (database: OrchestrationDatabase) => T | Promise<T>,
  ): Promise<T> {
    if (!this.initialized) {
      throw new OrchestrationStoreError(
        "Orchestration store used before initialize()",
      );
    }
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      const sanitized = redactRecord(next);
      sanitized.version = ORCHESTRATION_SCHEMA_VERSION;
      await this.persist(sanitized);
      this.data = sanitized;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return result;
  }

  private async persist(data: OrchestrationDatabase): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
