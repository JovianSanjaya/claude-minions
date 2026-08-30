import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ContractCriterion,
  ExecutionContract,
  OrchestrationSink,
  VerificationRecord,
} from "../contracts.js";
import { isWithin } from "./application-map.js";

/**
 * Trusted verification outside worker authority.
 *
 * Worker-visible checks help a worker iterate. Protected and global checks are
 * defined in trusted storage (mode 0700), never mounted into a worker snapshot,
 * and never returned in evidence beyond a safe summary. A worker cannot edit an
 * evaluator or mark its own result passed.
 */

export type CheckScope = VerificationRecord["scope"];

export interface TrustedCheckDefinition {
  id: string;
  description: string;
  /** argv[0]. Never a shell string and never browser-controlled. */
  command: string;
  args: string[];
  scope: CheckScope;
  timeoutMs?: number | undefined;
}

const checkDefinitionSchema = z.object({
  id: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  command: z.string().min(1).max(200),
  args: z.array(z.string().max(500)).max(50),
  scope: z.enum(["worker-visible", "protected", "global", "manual"]),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export interface CommandExecutor {
  run(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; output: string }>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_OUTPUT_CHARS = 4_000;

/** Argv-only executor with bounded output and time. No shell interpolation. */
export class ProcessCommandExecutor implements CommandExecutor {
  constructor(private readonly maxBuffer = 1_048_576) {}

  run(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      execFile(
        input.command,
        input.args,
        {
          cwd: input.cwd,
          timeout: input.timeoutMs,
          maxBuffer: this.maxBuffer,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          const output = (String(stdout) + "\n" + String(stderr)).trim();
          if (!error) {
            resolve({ exitCode: 0, output });
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve({
            exitCode: typeof code === "number" ? code : 1,
            output: output || error.message,
          });
        },
      );
    });
  }
}

export interface VerificationServiceOptions {
  orchestrationId: string;
  /** Trusted application-data path. Must live outside every Agent workspace. */
  protectedRoot: string;
  executor: CommandExecutor;
  sink: OrchestrationSink;
  clock?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
}

export class VerificationService {
  constructor(private readonly options: VerificationServiceOptions) {}

  private get now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private storagePath(): string {
    return path.join(
      path.resolve(this.options.protectedRoot),
      sanitize(this.options.orchestrationId) + ".json",
    );
  }

  /**
   * Persists the protected check set for this orchestration into mode-0700
   * trusted storage. Definitions come from trusted configuration keyed by
   * confirmed contract criterion IDs, never from model or browser text.
   */
  async installProtectedChecks(
    contract: ExecutionContract,
    catalog: Record<string, TrustedCheckDefinition>,
  ): Promise<TrustedCheckDefinition[]> {
    const selected: TrustedCheckDefinition[] = [];
    for (const criterion of contract.criteria) {
      if (criterion.verification === "manual") continue;
      const definition = catalog[criterion.id];
      if (!definition) continue;
      if (definition.scope === "worker-visible") continue;
      selected.push(definition);
    }
    const root = path.resolve(this.options.protectedRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700).catch(() => undefined);
    await writeFile(this.storagePath(), JSON.stringify(selected, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    return selected;
  }

  async loadProtectedChecks(): Promise<TrustedCheckDefinition[]> {
    const raw = await readFile(this.storagePath(), "utf8").catch(() => null);
    if (raw === null) return [];
    try {
      const parsed = z.array(checkDefinitionSchema).parse(JSON.parse(raw));
      return parsed.map((entry) => ({
        ...entry,
        ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
      })) as TrustedCheckDefinition[];
    } catch {
      return [];
    }
  }

  /**
   * Confirms the protected evaluator storage is not reachable from a worker or
   * staging workspace. A true result means the evaluator was never mounted.
   */
  isProtectedStorageIsolatedFrom(workspacePath: string): boolean {
    return !isWithin(
      path.resolve(this.options.protectedRoot),
      path.resolve(workspacePath),
    );
  }

  /** Runs a set of trusted checks and records each result through the sink. */
  async runChecks(input: {
    checks: TrustedCheckDefinition[];
    workspacePath: string;
    taskId: string | null;
    /** Overrides each check's own scope, used for global candidate runs. */
    scopeOverride?: CheckScope | undefined;
  }): Promise<{ passed: boolean; records: VerificationRecord[]; failing: string[] }> {
    const records: VerificationRecord[] = [];
    const failing: string[] = [];
    for (const check of input.checks) {
      const startedAt = this.now.toISOString();
      const outcome = await this.options.executor.run({
        command: check.command,
        args: check.args,
        cwd: input.workspacePath,
        timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      });
      const record: VerificationRecord = {
        id: (this.options.idFactory ?? randomUUID)(),
        orchestrationId: this.options.orchestrationId,
        taskId: input.taskId,
        scope: input.scopeOverride ?? check.scope,
        // The check ID and description are safe; the evaluator argv is not
        // disclosed for protected or global scopes.
        commandOrCheck:
          check.scope === "worker-visible"
            ? check.id + ": " + check.command + " " + check.args.join(" ")
            : check.id,
        status: outcome.exitCode === 0 ? "passed" : "failed",
        outputSummary: summarizeOutput(check, outcome.output),
        startedAt,
        completedAt: this.now.toISOString(),
      };
      records.push(record);
      if (record.status === "failed") failing.push(check.id);
      await this.options.sink.recordVerification(record);
    }
    return { passed: failing.length === 0, records, failing };
  }

  /**
   * Records manual acceptance criteria explicitly. Subjective requirements are
   * never given a fake automated oracle.
   */
  async recordManualCriteria(
    criteria: ContractCriterion[],
    taskId: string | null,
  ): Promise<VerificationRecord[]> {
    const records: VerificationRecord[] = [];
    for (const criterion of criteria.filter((item) => item.verification === "manual")) {
      const timestamp = this.now.toISOString();
      const record: VerificationRecord = {
        id: (this.options.idFactory ?? randomUUID)(),
        orchestrationId: this.options.orchestrationId,
        taskId,
        scope: "manual",
        commandOrCheck: criterion.id,
        status: "skipped",
        outputSummary:
          "Manual acceptance required: " + criterion.description.slice(0, 300),
        startedAt: timestamp,
        completedAt: timestamp,
      };
      records.push(record);
      await this.options.sink.recordVerification(record);
    }
    return records;
  }

  /**
   * Records contract criteria that have no trusted automated check configured,
   * so a missing evaluator is visible instead of silently counting as a pass.
   */
  async recordUncoveredCriteria(
    contract: ExecutionContract,
    catalog: Record<string, TrustedCheckDefinition>,
  ): Promise<VerificationRecord[]> {
    const records: VerificationRecord[] = [];
    for (const criterion of contract.criteria) {
      if (criterion.verification === "manual") continue;
      if (catalog[criterion.id]) continue;
      const timestamp = this.now.toISOString();
      const record: VerificationRecord = {
        id: (this.options.idFactory ?? randomUUID)(),
        orchestrationId: this.options.orchestrationId,
        taskId: null,
        scope: criterion.verification === "protected-test" ? "protected" : "global",
        commandOrCheck: criterion.id,
        status: "skipped",
        outputSummary:
          "No trusted automated check is configured for this criterion; it was not verified",
        startedAt: timestamp,
        completedAt: timestamp,
      };
      records.push(record);
      await this.options.sink.recordVerification(record);
    }
    return records;
  }
}

/**
 * Worker-visible checks a worker is allowed to know about and run. Protected
 * and global entries stay in trusted storage only.
 */
export function workerVisibleChecks(
  catalog: Record<string, TrustedCheckDefinition>,
): TrustedCheckDefinition[] {
  return Object.values(catalog).filter((check) => check.scope === "worker-visible");
}

export function globalChecks(
  catalog: Record<string, TrustedCheckDefinition>,
): TrustedCheckDefinition[] {
  return Object.values(catalog).filter((check) => check.scope === "global");
}

function summarizeOutput(check: TrustedCheckDefinition, output: string): string {
  const trimmed = output.trim();
  if (check.scope === "protected") {
    // Never leak protected evaluator internals: report pass/fail detail only.
    return trimmed
      ? "Protected check " + check.id + " produced " + trimmed.length + " characters of output"
      : "Protected check " + check.id + " produced no output";
  }
  if (!trimmed) return check.id + ": no output";
  return trimmed.length > MAX_CHECK_OUTPUT_CHARS
    ? trimmed.slice(0, MAX_CHECK_OUTPUT_CHARS) + "\n... output truncated"
    : trimmed;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64) || "orchestration";
}
