import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApplicationMapSummary,
  ContextPacketSummary,
  ContractAmendment,
  ExecutionContract,
  IntentDraft,
  Orchestration,
  OrchestrationEvent,
  OrchestrationTask,
  SharedArtifact,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";

export const ORCHESTRATION_DB_VERSION = 1;

export interface OrchestrationDb {
  version: typeof ORCHESTRATION_DB_VERSION;
  orchestrations: Orchestration[];
  intentDrafts: IntentDraft[];
  contracts: ExecutionContract[];
  amendments: ContractAmendment[];
  events: OrchestrationEvent[];
  tasks: OrchestrationTask[];
  applicationMaps: ApplicationMapSummary[];
  contextPackets: ContextPacketSummary[];
  attempts: WorkerAttempt[];
  artifacts: SharedArtifact[];
  verifications: VerificationRecord[];
}

const emptyDatabase = (): OrchestrationDb => ({
  version: ORCHESTRATION_DB_VERSION,
  orchestrations: [],
  intentDrafts: [],
  contracts: [],
  amendments: [],
  events: [],
  tasks: [],
  applicationMaps: [],
  contextPackets: [],
  attempts: [],
  artifacts: [],
  verifications: [],
});

const REQUIRED_ARRAY_KEYS: Array<keyof OrchestrationDb> = [
  "orchestrations",
  "intentDrafts",
  "contracts",
  "amendments",
  "events",
  "tasks",
  "applicationMaps",
  "contextPackets",
  "attempts",
  "artifacts",
  "verifications",
];

function isPlausibleDatabase(value: unknown): value is OrchestrationDb {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OrchestrationDb>;
  return REQUIRED_ARRAY_KEYS.every((key) => Array.isArray(candidate[key]));
}

/**
 * Separate single-process JSON database for the orchestration control plane.
 * Kept apart from the baseline `launchpad.json` store so that orchestration
 * work cannot corrupt or delay Agent CRUD persistence, and so restart
 * reconciliation for the two domains can evolve independently.
 */
export class OrchestrationStore {
  private data: OrchestrationDb = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isPlausibleDatabase(parsed)) {
        throw new Error("Unsupported orchestration database format");
      }
      if (parsed.version !== ORCHESTRATION_DB_VERSION) {
        throw new Error(
          `Unsupported orchestration database version: ${String(
            (parsed as { version?: unknown }).version,
          )}`,
        );
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): OrchestrationDb {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: OrchestrationDb) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: OrchestrationDb = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
