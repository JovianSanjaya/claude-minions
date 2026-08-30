import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { OrchestrationSink, VerificationRecord } from "../contracts.js";

const execFileAsync = promisify(execFile);

export interface CheckDefinition {
  name: string;
  scope: VerificationRecord["scope"];
}

export interface CheckOutcome {
  status: "passed" | "failed" | "skipped";
  outputSummary: string;
}

/** A worker never supplies the command that runs against it — only trusted, injected implementations do. */
export type CheckRunner = (check: CheckDefinition, workspacePath: string) => Promise<CheckOutcome>;

const MAX_OUTPUT_CHARS = 4_000;

/**
 * Runs a set of checks and persists each as a `VerificationRecord` via the
 * sink, regardless of outcome — evidence exists whether a check passes or
 * fails. `scope` distinguishes worker-visible checks (help the worker
 * iterate; don't determine final success) from protected/global ones (run
 * outside worker authority and gate publication).
 */
export async function runChecks(
  orchestrationId: string,
  taskId: string | null,
  checks: CheckDefinition[],
  workspacePath: string,
  runner: CheckRunner,
  sink: OrchestrationSink,
): Promise<VerificationRecord[]> {
  const records: VerificationRecord[] = [];
  for (const check of checks) {
    const startedAt = new Date().toISOString();
    const outcome = await runner(check, workspacePath);
    const record: VerificationRecord = {
      id: randomUUID(),
      orchestrationId,
      taskId,
      scope: check.scope,
      commandOrCheck: check.name,
      status: outcome.status,
      outputSummary: outcome.outputSummary.slice(0, MAX_OUTPUT_CHARS),
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await sink.recordVerification(record);
    records.push(record);
  }
  return records;
}

export function allPassed(records: VerificationRecord[]): boolean {
  return records.every((record) => record.status === "passed");
}

export interface TrustedCommand {
  name: string;
  command: string;
  args: string[];
}

/**
 * The real, trusted check runner: looks up the actual command/args from a
 * server-side configured allowlist by check *name* — a worker or browser
 * value can never supply an arbitrary shell string. Bounded output and
 * timeout. Not used by any test in this build (tests inject deterministic
 * fakes); this is the production implementation Final Assembly wires in.
 */
export function createTrustedCommandRunner(
  commands: TrustedCommand[],
  timeoutMs = 120_000,
  maxOutputBytes = 200_000,
): CheckRunner {
  const byName = new Map(commands.map((entry) => [entry.name, entry]));
  return async (check, workspacePath) => {
    const trusted = byName.get(check.name);
    if (!trusted) {
      return { status: "skipped", outputSummary: `No trusted command configured for check "${check.name}"` };
    }
    try {
      const { stdout, stderr } = await execFileAsync(trusted.command, trusted.args, {
        cwd: workspacePath,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
      });
      return { status: "passed", outputSummary: (stdout || stderr || "(no output)").toString() };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      return {
        status: "failed",
        outputSummary: (failure.stdout || failure.stderr || failure.message || "Check failed").toString(),
      };
    }
  };
}
