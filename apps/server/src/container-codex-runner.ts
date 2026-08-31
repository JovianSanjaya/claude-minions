import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexSessionTelemetryTracker } from "./codex-session-telemetry.js";
import type { AppConfig } from "./config.js";
import { writeCodexConfig } from "./config.js";
import {
  buildCodexArgs,
  consumeCodexOutputChunk,
  parseCodexEventLine,
} from "./codex-runner.js";
import { RunCancelledError, RunnerExecutionError } from "./errors.js";
import { errorIdentity, transportTarget } from "./transport-diagnostics.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
  TransportDiagnostics,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  budgetExceeded: string | null;
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

function normalizedAllowedWritePaths(request: RunnerRequest): string[] {
  if (request.sandboxMode !== "workspace-write" || !request.allowedWritePaths?.length) {
    return [];
  }
  const normalized = request.allowedWritePaths.map((value) => {
    const raw = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const candidate = path.posix.normalize(raw);
    if (candidate === ".") return candidate;
    if (
      !candidate || candidate.startsWith("/") || candidate.split("/").includes("..") ||
      /^[A-Za-z]:\//.test(candidate) || /[,\0\r\n]/.test(candidate)
    ) {
      throw new Error(`Unsafe allowed write path: ${value}`);
    }
    return candidate;
  }).sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const result: string[] = [];
  for (const candidate of normalized) {
    if (result.some((parent) => parent === "." || candidate === parent || candidate.startsWith(`${parent}/`))) {
      continue;
    }
    result.push(candidate);
  }
  return result;
}

function scopedWorkspaceMountArgs(request: RunnerRequest): string[] {
  const allowed = normalizedAllowedWritePaths(request);
  if (!allowed.length || allowed.includes(".")) return [];
  return allowed.flatMap((relative) => [
    "--mount",
    `type=bind,src=${path.join(request.workspacePath, ...relative.split("/"))},dst=/workspace/${relative}`,
  ]);
}

function likelyFilePath(relative: string): boolean {
  const name = path.posix.basename(relative);
  if (path.posix.extname(name)) return true;
  return new Set([
    ".gitignore",
    ".dockerignore",
    "Dockerfile",
    "Makefile",
    "Procfile",
    "LICENSE",
  ]).has(name);
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.executionId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const allowedWritePaths = normalizedAllowedWritePaths(request);
  const scopedWorkspace = allowedWritePaths.length > 0 && !allowedWritePaths.includes(".");
  return [
    "run",
    "--rm",
    "--interactive",
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
    "io.codejam.runtime-profile=" + (request.runtimeProfile ?? "default"),
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--read-only",
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
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=" + config.containerTmpfsSize + ",mode=1777",
    "--shm-size",
    config.containerShmSize,
    "--user",
    config.containerUser,
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "XDG_CACHE_HOME=/tmp/.cache",
    "--env",
    "XDG_CONFIG_HOME=/tmp/.config",
    "--env",
    "XDG_RUNTIME_DIR=/tmp/runtime",
    "--env",
    "CHROME_BIN=/usr/bin/chromium",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace" +
      (request.sandboxMode === "read-only" || scopedWorkspace ? ",readonly" : ""),
    ...scopedWorkspaceMountArgs(request),
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

  async diagnoseTransport(): Promise<TransportDiagnostics> {
    const target = transportTarget(this.config.arkBaseUrl);
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    const script = [
      "const {lookup}=require('node:dns').promises;",
      "const target=process.argv[1];",
      "const started=Date.now();",
      "let dnsAddress=null;",
      "const identity=(error)=>({code:error?.code??error?.cause?.code??null,message:error?.cause?.message&&!String(error?.message).includes(error.cause.message)?String(error?.message)+': '+error.cause.message:String(error?.message??error)});",
      "(async()=>{try{dnsAddress=(await lookup(new URL(target).hostname)).address;}catch(error){const e=identity(error);console.log(JSON.stringify({dnsAddress,httpStatus:null,elapsedMs:Date.now()-started,errorCode:e.code,errorMessage:e.message}));return;}try{const response=await fetch(target,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(10000)});await response.body?.cancel();console.log(JSON.stringify({dnsAddress,httpStatus:response.status,elapsedMs:Date.now()-started,errorCode:null,errorMessage:null}));}catch(error){const e=identity(error);console.log(JSON.stringify({dnsAddress,httpStatus:null,elapsedMs:Date.now()-started,errorCode:e.code,errorMessage:e.message}));}})();",
    ].join("");
    try {
      const { stdout } = await execFileAsync(
        this.config.containerEngine,
        [
          "run", "--rm", "--network", "bridge", "--read-only",
          "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
          "--user", this.config.containerUser,
          this.config.containerRuntimeImage,
          "node", "-e", script, target,
        ],
        { timeout: 15_000, env: this.childEnvironment(), maxBuffer: 65_536 },
      );
      const parsed = JSON.parse(stdout.trim()) as Omit<TransportDiagnostics, "checkedAt" | "target">;
      return { checkedAt, target, ...parsed };
    } catch (error) {
      const identity = errorIdentity(error);
      return {
        checkedAt,
        target,
        dnsAddress: null,
        httpStatus: null,
        elapsedMs: Date.now() - startedAt,
        errorCode: identity.code,
        errorMessage: `Container transport diagnostic failed: ${identity.message}`,
      };
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
    await this.prepareAllowedWriteMounts(request);

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
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
      budgetExceeded: null,
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
    const telemetryTracker = request.runtimeHomePath
      ? await CodexSessionTelemetryTracker.create(request.runtimeHomePath)
      : null;
    const streams = { stdoutBuffer: "", stderrTail: "", stdoutBytes: 0 };

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (consumeCodexOutputChunk(streams, chunk, target, this.config.codexMaxOutputBytes, parsed)) {
        active.outputExceeded = true;
        void this.removeContainer(active);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.prompt);

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();
    let telemetryPolling = false;
    const telemetryInterval = telemetryTracker && (request.maxArkApiTurns || request.maxInputTokens)
      ? setInterval(() => {
          if (telemetryPolling || active.budgetExceeded) return;
          telemetryPolling = true;
          void telemetryTracker.poll().then((telemetry) => {
            if (request.maxArkApiTurns && telemetry.arkApiTurns >= request.maxArkApiTurns) {
              active.budgetExceeded = `Ark-turn limit exceeded (${telemetry.arkApiTurns}/${request.maxArkApiTurns})`;
              void this.removeContainer(active);
            } else if (request.maxInputTokens && telemetry.inputTokens >= request.maxInputTokens) {
              active.budgetExceeded = `Per-execution input-token limit exceeded (${telemetry.inputTokens}/${request.maxInputTokens})`;
              void this.removeContainer(active);
            }
          }).finally(() => { telemetryPolling = false; });
        }, 1_000)
      : null;
    telemetryInterval?.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (streams.stdoutBuffer.trim()) parseCodexEventLine(streams.stdoutBuffer.trim(), parsed);
      const telemetry = telemetryTracker ? await telemetryTracker.poll(true) : null;
      const usage = telemetry && telemetry.arkApiTurns > 0
        ? {
            inputTokens: telemetry.inputTokens,
            cachedInputTokens: telemetry.cachedInputTokens,
            outputTokens: telemetry.outputTokens,
            arkApiTurns: telemetry.arkApiTurns,
            toolCalls: telemetry.toolCalls,
            streamRetries: telemetry.streamRetries,
            peakContextTokens: telemetry.peakContextTokens,
          }
        : parsed.usage;
      const partial = {
        threadId: parsed.threadId,
        usage,
        output: parsed.messages.at(-1)?.trim() || null,
      };
      if (active.cancelled) throw new RunCancelledError(partial);
      if (active.timedOut) {
        throw new RunnerExecutionError("Runtime timed out after " + this.config.codexTimeoutMs + " ms", partial);
      }
      if (active.outputExceeded) {
        throw new RunnerExecutionError("Codex output exceeded CODEX_MAX_OUTPUT_BYTES", partial);
      }
      if (active.budgetExceeded) {
        throw new RunnerExecutionError(active.budgetExceeded, partial);
      }
      if (exitCode !== 0) {
        const structured = parsed.errors.at(-1)?.trim();
        const stderr = streams.stderrTail.trim();
        const detail = [
          structured,
          stderr && stderr !== structured ? `stderr: ${stderr}` : null,
        ].filter(Boolean).join(" | ") || "No error detail";
        throw new RunnerExecutionError(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
          partial,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new RunnerExecutionError("Codex completed without an agent message", partial);
      return {
        output,
        threadId: parsed.threadId,
        usage,
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
      if (telemetryInterval) clearInterval(telemetryInterval);
      this.active.delete(request.executionId);
    }
  }

  private async prepareAllowedWriteMounts(request: RunnerRequest): Promise<void> {
    const allowed = normalizedAllowedWritePaths(request);
    if (!allowed.length || allowed.includes(".")) return;
    const workspaceRoot = await realpath(request.workspacePath);
    for (const relative of allowed) {
      const target = path.resolve(workspaceRoot, ...relative.split("/"));
      if (!target.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error(`Allowed write path escapes the workspace: ${relative}`);
      }
      let current = workspaceRoot;
      for (const segment of relative.split("/")) {
        current = path.join(current, segment);
        const currentStats = await lstat(current).catch(() => null);
        if (!currentStats) break;
        if (currentStats.isSymbolicLink()) {
          throw new Error(`Allowed write path cannot traverse a symlink: ${relative}`);
        }
      }
      const stats = await lstat(target).catch(() => null);
      if (stats) continue;
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (likelyFilePath(relative)) {
        const handle = await open(target, "a", 0o600);
        await handle.close();
      } else {
        await mkdir(target, { recursive: true, mode: 0o700 });
      }
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
