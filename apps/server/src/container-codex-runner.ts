import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { writeCodexConfig } from "./config.js";
import {
  buildCodexArgs,
  consumeCodexOutputChunk,
  parseCodexEventLine,
} from "./codex-runner.js";
import { RunCancelledError, RunFailedError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function containerName(executionId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeExecution = executionId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeExecution;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.executionId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.execution-id=" + request.executionId,
    ...(request.orchestrationId
      ? ["--label", "io.codejam.orchestration-id=" + request.orchestrationId]
      : []),
    ...(request.taskId ? ["--label", "io.codejam.task-id=" + request.taskId] : []),
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace" +
      (request.sandboxMode === "read-only" ? ",readonly" : ""),
    "--mount",
    "type=bind,src=" + (request.runtimeHomePath ?? config.codexHome) + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(
      request,
      // Docker/Podman is the security boundary here. Running Codex's Linux
      // Landlock sandbox inside this already-restricted container fails on
      // Docker Desktop before any tool can execute. Read-only calls remain
      // protected by the read-only /workspace bind mount above.
      "danger-full-access",
      "/workspace",
      config.codexModelOverrideSupported,
    ),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(executionId: string): Promise<boolean> {
    const active = this.active.get(executionId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.executionId)) {
      throw new Error("Execution already has an active Runtime container");
    }

    if (request.runtimeHomePath) {
      await writeCodexConfig(this.config, request.runtimeHomePath);
    }

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.executionId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
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
        void this.removeContainer(active);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (streams.stdoutBuffer.trim()) parseCodexEventLine(streams.stdoutBuffer.trim(), parsed);
      if (active.cancelled) throw new RunCancelledError(parsed.threadId);
      if (active.timedOut) {
        throw new RunFailedError(
          "Runtime timed out after " + this.config.codexTimeoutMs + " ms",
          parsed.threadId,
        );
      }
      if (active.outputExceeded) {
        throw new RunFailedError("Codex output exceeded CODEX_MAX_OUTPUT_BYTES", parsed.threadId);
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? streams.stderrTail.trim() ?? "No error detail";
        throw new RunFailedError(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
          parsed.threadId,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new RunFailedError("Codex completed without an agent message", parsed.threadId);
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
      this.active.delete(request.executionId);
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
