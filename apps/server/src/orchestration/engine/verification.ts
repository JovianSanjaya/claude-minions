import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  OrchestrationSink,
  VerificationRecord,
} from "../contracts.js";

const execFileAsync = promisify(execFile);

export interface TrustedVerificationCheck {
  id: string;
  description: string;
  scope: VerificationRecord["scope"];
  executable?: string;
  args?: string[];
  timeoutMs?: number;
  run?: (workspacePath: string, signal: AbortSignal) => Promise<{ passed: boolean; summary: string }>;
}

export class VerificationService {
  constructor(
    private readonly protectedRoot: string,
    private readonly checks: readonly TrustedVerificationCheck[],
    private readonly allowedExecutables: ReadonlySet<string>,
    private readonly newId: () => string = randomUUID,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.protectedRoot, { recursive: true, mode: 0o700 });
    await chmod(this.protectedRoot, 0o700);
  }

  async run(
    orchestrationId: string,
    taskId: string | null,
    workspacePath: string,
    scopes: VerificationRecord["scope"][],
    sink: OrchestrationSink,
    signal: AbortSignal,
  ): Promise<VerificationRecord[]> {
    await this.initialize();
    const records: VerificationRecord[] = [];
    for (const check of this.checks.filter((entry) => scopes.includes(entry.scope))) {
      if (signal.aborted) throw new Error("Verification cancelled");
      const startedAt = new Date().toISOString();
      let status: VerificationRecord["status"] = "failed";
      let outputSummary = "Verification did not run";
      if (check.scope === "manual") {
        status = "skipped";
        outputSummary = "Manual criterion requires explicit human review";
      } else if (check.run) {
        const result = await check.run(workspacePath, signal);
        status = result.passed ? "passed" : "failed";
        outputSummary = result.summary;
      } else if (check.executable) {
        if (!this.allowedExecutables.has(check.executable)) {
          throw new Error(`Verification executable is not trusted: ${check.executable}`);
        }
        try {
          const result = await execFileAsync(check.executable, check.args ?? [], {
            cwd: workspacePath,
            timeout: check.timeoutMs ?? 120_000,
            maxBuffer: 256_000,
          });
          status = "passed";
          outputSummary = (result.stdout || result.stderr || "Check passed").slice(0, 8_000);
        } catch (error) {
          const detail = error as { stdout?: string; stderr?: string; message?: string };
          outputSummary = (detail.stdout || detail.stderr || detail.message || "Check failed").slice(0, 8_000);
        }
      }
      const record: VerificationRecord = {
        id: this.newId(),
        orchestrationId,
        taskId,
        scope: check.scope,
        commandOrCheck: check.description,
        status,
        outputSummary,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      await sink.recordVerification(record);
      records.push(record);
    }
    return records;
  }
}

export function requiredVerificationPassed(records: VerificationRecord[]): boolean {
  return records.every((record) => record.scope === "manual" || record.status === "passed");
}
