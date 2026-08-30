import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { writeCodexConfig } from "./config.js";
import { RunCancelledError, RunFailedError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export interface CodexOutputAccumulator {
  stdoutBuffer: string;
  stderrTail: string;
  stdoutBytes: number;
}

const STDERR_TAIL_CHARACTERS = 16_384;

/**
 * Consume Codex's machine-readable stdout without allowing noisy diagnostic
 * stderr to exhaust the agent-message output budget. Stderr is continuously
 * drained and tail-capped so a chatty provider cannot grow server memory.
 */
export function consumeCodexOutputChunk(
  accumulator: CodexOutputAccumulator,
  chunk: Buffer,
  target: "stdout" | "stderr",
  maxStdoutBytes: number,
  parsed: ParsedEvents,
): boolean {
  if (target === "stderr") {
    accumulator.stderrTail = (accumulator.stderrTail + chunk.toString("utf8"))
      .slice(-STDERR_TAIL_CHARACTERS);
    return false;
  }

  accumulator.stdoutBytes += chunk.byteLength;
  if (accumulator.stdoutBytes > maxStdoutBytes) return true;

  accumulator.stdoutBuffer += chunk.toString("utf8");
  const lines = accumulator.stdoutBuffer.split(/\r?\n/);
  accumulator.stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) parseCodexEventLine(line, parsed);
  return false;
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
  modelOverrideSupported = true,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.modelId && modelOverrideSupported) args.push("--model", request.modelId);
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(executionId: string): Promise<boolean> {
    const active = this.active.get(executionId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.executionId)) {
      throw new Error("Execution already has an active Codex process");
    }

    if (request.runtimeHomePath) {
      await writeCodexConfig(this.config, request.runtimeHomePath);
    }

    const args = buildCodexArgs(
      request,
      request.sandboxMode ?? this.config.codexSandboxMode,
      request.workspacePath,
      this.config.codexModelOverrideSupported,
    );
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(request.runtimeHomePath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.executionId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    const streams = { stdoutBuffer: "", stderrTail: "", stdoutBytes: 0 };

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (consumeCodexOutputChunk(streams, chunk, target, this.config.codexMaxOutputBytes, parsed)) {
        active.outputExceeded = true;
        this.terminate(active);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (streams.stdoutBuffer.trim()) {
        parseCodexEventLine(streams.stdoutBuffer.trim(), parsed);
      }
      if (active.cancelled) {
        throw new RunCancelledError(parsed.threadId);
      }
      if (active.timedOut) {
        throw new RunFailedError(
          "Codex timed out after " + this.config.codexTimeoutMs + " ms",
          parsed.threadId,
        );
      }
      if (active.outputExceeded) {
        throw new RunFailedError("Codex output exceeded CODEX_MAX_OUTPUT_BYTES", parsed.threadId);
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? streams.stderrTail.trim() ?? "No error detail";
        throw new RunFailedError("Codex exited with code " + exitCode + ": " + detail, parsed.threadId);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new RunFailedError("Codex completed without an agent message", parsed.threadId);
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
        modelId:
          request.modelId && this.config.codexModelOverrideSupported
            ? request.modelId
            : this.config.arkModel,
        modelFallback:
          Boolean(request.modelId) &&
          !this.config.codexModelOverrideSupported &&
          request.modelId !== this.config.arkModel,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.executionId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(runtimeHomePath?: string): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: runtimeHomePath ?? this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
