import { execFile } from "node:child_process";
import { chmod, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OrchestrationSink,
  VerificationRecord,
} from "../contracts.js";

export interface TrustedVerificationCheck {
  id: string;
  scope: VerificationRecord["scope"];
  command: string;
  args: string[];
  cwd: "workspace" | "protected-root";
  timeoutMs?: number;
}

export interface VerificationExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VerificationExecutor {
  execute(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<VerificationExecutionResult>;
}

class ExecFileVerificationExecutor implements VerificationExecutor {
  execute(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<VerificationExecutionResult> {
    return new Promise((resolve, reject) => {
      execFile(
        input.command,
        input.args,
        {
          cwd: input.cwd,
          timeout: input.timeoutMs,
          maxBuffer: input.maxOutputBytes,
          signal: input.signal,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            LANG: process.env.LANG,
            CI: "1",
            NO_COLOR: "1",
          },
        },
        (error, stdout, stderr) => {
          if (error && !("code" in error && typeof error.code === "number")) {
            reject(error);
            return;
          }
          resolve({
            exitCode:
              error && "code" in error && typeof error.code === "number" ? error.code : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
  }
}

const SECRET_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._~-]{8,}|(?:api[_-]?key|password|token)\s*[:=]\s*[^\s,;]+)/gi;
function safeOutput(value: string): string {
  return value.replace(SECRET_VALUE, "[REDACTED]").slice(0, 8_000);
}

export interface VerificationRunResult {
  passed: boolean;
  configured: boolean;
  records: VerificationRecord[];
}

export class VerificationService {
  private readonly executor: VerificationExecutor;

  constructor(
    private readonly protectedRoot: string,
    private readonly checks: TrustedVerificationCheck[],
    executor?: VerificationExecutor,
    private readonly maxOutputBytes = 256_000,
  ) {
    this.executor = executor ?? new ExecFileVerificationExecutor();
  }

  async initialize(): Promise<void> {
    const resolved = path.resolve(this.protectedRoot);
    if (resolved === path.parse(resolved).root) {
      throw new Error("Protected evaluator root may not be the filesystem root");
    }
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  }

  async run(input: {
    orchestrationId: string;
    taskId: string | null;
    workspacePath: string;
    scopes: VerificationRecord["scope"][];
    sink: OrchestrationSink;
    signal: AbortSignal;
  }): Promise<VerificationRunResult> {
    await this.initialize();
    const workspace = await realpath(input.workspacePath);
    const protectedRoot = await realpath(this.protectedRoot);
    if (
      protectedRoot === workspace ||
      protectedRoot.startsWith(workspace + path.sep) ||
      workspace.startsWith(protectedRoot + path.sep)
    ) {
      throw new Error("Protected evaluator storage must be outside worker workspaces");
    }
    const applicable = this.checks.filter((check) => input.scopes.includes(check.scope));
    const records: VerificationRecord[] = [];
    for (const check of applicable) {
      const startedAt = new Date().toISOString();
      let result: VerificationExecutionResult;
      try {
        result = await this.executor.execute({
          command: check.command,
          args: [...check.args],
          cwd: check.cwd === "workspace" ? workspace : protectedRoot,
          timeoutMs: check.timeoutMs ?? 120_000,
          maxOutputBytes: this.maxOutputBytes,
          signal: input.signal,
        });
      } catch (error) {
        result = {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      const record: VerificationRecord = {
        id: randomUUID(),
        orchestrationId: input.orchestrationId,
        taskId: input.taskId,
        scope: check.scope,
        commandOrCheck: check.id,
        status: result.exitCode === 0 ? "passed" : "failed",
        outputSummary: safeOutput(
          [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
        ),
        startedAt,
        completedAt: new Date().toISOString(),
      };
      records.push(record);
      await input.sink.recordVerification(record);
    }
    return {
      passed: records.every((record) => record.status === "passed"),
      configured: applicable.length > 0,
      records,
    };
  }
}
