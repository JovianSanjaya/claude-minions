import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ApplicationMapSummary,
  ContextPacketSummary,
  ContractAmendment,
  ExecutionContract,
  IntentDraft,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationTask,
  PlanResult,
  SharedArtifact,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { redactClone } from "./redaction.js";

export interface StoredReservation extends ModelCallReservation {
  id: string;
  estimatedUsd: number | null;
  createdAt: string;
}

export interface CleanupRecord {
  orchestrationId: string;
  policy: "clean" | "archive" | "retain";
  status: "pending" | "cleaned" | "archived" | "retained" | "failed";
  summary: string;
  updatedAt: string;
}

export interface StoredPlan {
  orchestrationId: string;
  selectedMode: PlanResult["selectedMode"];
  routeReason: string;
  applicationMapVersion: number;
  createdAt: string;
}

export interface OrchestrationDatabase {
  version: 1;
  orchestrations: Orchestration[];
  intentDrafts: IntentDraft[];
  contracts: ExecutionContract[];
  amendments: ContractAmendment[];
  plans: StoredPlan[];
  tasks: OrchestrationTask[];
  applicationMaps: ApplicationMapSummary[];
  contextPackets: ContextPacketSummary[];
  attempts: WorkerAttempt[];
  artifacts: SharedArtifact[];
  verifications: VerificationRecord[];
  events: OrchestrationEvent[];
  reservations: StoredReservation[];
  cleanup: CleanupRecord[];
  benchmarkReferences: Array<Record<string, unknown>>;
}

const finiteNonNegative = z.number().finite().nonnegative();
const nullableLimit = finiteNonNegative.nullable();
const tokenUsageSchema = z.object({
  inputTokens: finiteNonNegative,
  cachedInputTokens: finiteNonNegative,
  outputTokens: finiteNonNegative,
});
const roleUsageSchema = tokenUsageSchema.extend({
  modelId: z.string(),
  estimatedUsd: nullableLimit,
  modelCalls: finiteNonNegative,
});
const usageSchema = z.object({
  byRole: z.record(z.string(), roleUsageSchema),
  totalInputTokens: finiteNonNegative,
  totalCachedInputTokens: finiteNonNegative,
  totalOutputTokens: finiteNonNegative,
  totalEstimatedUsd: nullableLimit,
  pricingStatus: z.enum(["configured", "unknown"]),
});
const orchestrationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  prompt: z.string(),
  requestedMode: z.enum(["auto", "direct", "orchestrated"]),
  modelStrategy: z.enum(["mixed", "big-only", "small-only"]).default("mixed"),
  workerRouting: z.enum(["adaptive", "one-worker", "multi-worker"]).default("adaptive"),
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
  currentIntentDraftId: z.string().nullable(),
  activeContractId: z.string().nullable(),
  estimate: z.object({
    inputTokenLow: finiteNonNegative,
    inputTokenHigh: finiteNonNegative,
    outputTokenLow: finiteNonNegative,
    outputTokenHigh: finiteNonNegative,
    estimatedUsdLow: nullableLimit,
    estimatedUsdHigh: nullableLimit,
    pricingStatus: z.enum(["configured", "unknown"]),
    assumptions: z.array(z.string()),
  }).nullable(),
  budget: z.object({
    maxInputTokens: nullableLimit,
    maxOutputTokens: nullableLimit,
    maxEstimatedUsd: nullableLimit,
    maxModelCalls: finiteNonNegative,
    maxSteps: finiteNonNegative,
    maxWorkerAttempts: finiteNonNegative,
    maxContextExpansionsPerTask: finiteNonNegative,
    maxWallClockMs: finiteNonNegative,
  }),
  usage: usageSchema,
  finalOutput: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

const criterionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["functional", "architectural", "scope", "runtime", "manual"]),
  description: z.string(),
  verification: z.enum(["visible-test", "protected-test", "static-check", "manual"]),
});
const draftSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), revision: finiteNonNegative,
  goal: z.string(), requirements: z.array(z.string()), assumptions: z.array(z.string()),
  nonGoals: z.array(z.string()), architectureDecisions: z.array(z.string()),
  materialQuestions: z.array(z.string()), manualExpectations: z.array(z.string()),
  createdAt: z.string(),
});
const contractSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), version: finiteNonNegative,
  intent: draftSchema, criteria: z.array(criterionSchema), confirmedBy: z.literal("user"),
  confirmedAt: z.string(), supersedesContractId: z.string().nullable(),
});
const amendmentSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), baseContractId: z.string(),
  proposedIntent: draftSchema, proposedCriteria: z.array(criterionSchema).nullable(),
  reason: z.string(), material: z.boolean(), status: z.enum(["pending", "confirmed", "rejected"]),
  createdAt: z.string(), decidedAt: z.string().nullable(),
});
const taskSchema = z.object({
  id: z.string().min(1),
  orchestrationId: z.string().min(1),
  title: z.string(), objective: z.string(),
  status: z.enum(["blocked", "ready", "preflight", "running", "verifying", "stale", "passed", "failed", "cancelled"]),
  dependsOn: z.array(z.string()), allowedPaths: z.array(z.string()),
  acceptanceCriterionIds: z.array(z.string()), requiredArtifactIds: z.array(z.string()),
  observedArtifactVersions: z.record(z.string(), finiteNonNegative),
  applicationMapVersion: finiteNonNegative,
  attemptCount: finiteNonNegative,
});
const mapSchema = z.object({
  orchestrationId: z.string().min(1), version: finiteNonNegative,
  repositoryHash: z.string(), summary: z.string(), fileCount: finiteNonNegative,
  createdAt: z.string(),
});
const contextSchema = z.object({
  taskId: z.string().min(1), applicationMapVersion: finiteNonNegative,
  contractVersion: finiteNonNegative,
  sourceFiles: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: finiteNonNegative })),
  relevantInterfaces: z.array(z.string()),
  artifactVersions: z.record(z.string(), finiteNonNegative), estimatedTokens: finiteNonNegative,
});
const attemptSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), taskId: z.string(),
  number: finiteNonNegative, executionId: z.string(), modelId: z.string(),
  contextFileHashes: z.array(z.string()), changedFiles: z.array(z.string()),
  status: z.enum(["running", "passed", "failed", "cancelled"]), usage: tokenUsageSchema,
  errorSummary: z.string().nullable(), createdAt: z.string(), completedAt: z.string().nullable(),
});
const artifactSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), producerTaskId: z.string(),
  kind: z.enum(["api", "interface", "schema", "decision", "manifest", "test-result"]),
  name: z.string(), version: finiteNonNegative, payload: z.string(), createdAt: z.string(),
});
const verificationSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), taskId: z.string().nullable(),
  scope: z.enum(["worker-visible", "protected", "global", "manual"]),
  commandOrCheck: z.string(), status: z.enum(["passed", "failed", "skipped"]),
  outputSummary: z.string(), startedAt: z.string(), completedAt: z.string(),
});
const eventSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), taskId: z.string().nullable(),
  executionId: z.string().nullable(), type: z.string(),
  actorRole: z.enum(["user", "planner", "worker", "verifier", "integrator", "control-plane", "runtime"]),
  modelId: z.string().nullable(), summary: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
  createdAt: z.string(),
});
const reservationSchema = z.object({
  id: z.string().min(1), orchestrationId: z.string().min(1), taskId: z.string().nullable(),
  executionId: z.string(), role: z.enum(["planner", "worker", "verifier", "integrator"]),
  modelId: z.string(), estimatedInputTokens: finiteNonNegative,
  estimatedOutputTokens: finiteNonNegative, estimatedUsd: nullableLimit, createdAt: z.string(),
});
const cleanupSchema = z.object({
  orchestrationId: z.string().min(1),
  policy: z.enum(["clean", "archive", "retain"]),
  status: z.enum(["pending", "cleaned", "archived", "retained", "failed"]),
  summary: z.string(),
  updatedAt: z.string(),
});
const databaseSchema = z.object({
  version: z.literal(1),
  orchestrations: z.array(orchestrationSchema),
  intentDrafts: z.array(draftSchema),
  contracts: z.array(contractSchema),
  amendments: z.array(amendmentSchema),
  plans: z.array(z.object({
    orchestrationId: z.string().min(1),
    selectedMode: z.enum(["direct", "one-worker", "multi-worker"]),
    routeReason: z.string(), applicationMapVersion: finiteNonNegative, createdAt: z.string(),
  })),
  tasks: z.array(taskSchema),
  applicationMaps: z.array(mapSchema),
  contextPackets: z.array(contextSchema),
  attempts: z.array(attemptSchema),
  artifacts: z.array(artifactSchema),
  verifications: z.array(verificationSchema),
  events: z.array(eventSchema),
  reservations: z.array(reservationSchema),
  cleanup: z.array(cleanupSchema),
  benchmarkReferences: z.array(z.record(z.string(), z.unknown())),
}).strict();

export const emptyOrchestrationDatabase = (): OrchestrationDatabase => ({
  version: 1,
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
  reservations: [],
  cleanup: [],
  benchmarkReferences: [],
});

export type AtomicWriter = (filePath: string, data: string) => Promise<void>;

const atomicWriter: AtomicWriter = async (filePath, data) => {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, filePath);
};

export class OrchestrationStore {
  private data = emptyOrchestrationDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly writeAtomically: AtomicWriter = atomicWriter,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        (parsed as { version: unknown }).version !== 1
      ) {
        throw new Error(
          `Unsupported orchestration database version: ${String((parsed as { version: unknown }).version)}`,
        );
      }
      this.data = databaseSchema.parse(parsed) as unknown as OrchestrationDatabase;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.data);
    }
  }

  snapshot(): OrchestrationDatabase {
    return redactClone(this.data);
  }

  async mutate<T>(
    mutation: (database: OrchestrationDatabase) => T | Promise<T>,
  ): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      const safe = redactClone(next);
      databaseSchema.parse(safe);
      await this.persist(safe);
      this.data = safe;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
    return redactClone(result);
  }

  private async persist(data: OrchestrationDatabase): Promise<void> {
    await this.writeAtomically(
      this.filePath,
      `${JSON.stringify(redactClone(data), null, 2)}\n`,
    );
  }
}
