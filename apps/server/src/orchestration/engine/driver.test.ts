import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import type {
  ApplicationMapSummary,
  BudgetDecision,
  BudgetPolicy,
  ContextPacketSummary,
  ExecutionContract,
  ModelCallReservation,
  Orchestration,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { OrchestrationEngineDriver } from "./driver.js";
import type { CommandExecutor, TrustedCheckDefinition } from "./verification.js";
import { hashDirectory } from "./worker-workspaces.js";

// ---------------------------------------------------------------------------
// In-memory test doubles. These live only in tests; no production code path
// can reach them.
// ---------------------------------------------------------------------------

class FakeSink implements OrchestrationSink {
  readonly events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  readonly tasks = new Map<string, OrchestrationTask>();
  readonly maps: ApplicationMapSummary[] = [];
  readonly packets: ContextPacketSummary[] = [];
  readonly attempts: WorkerAttempt[] = [];
  readonly artifacts: SharedArtifact[] = [];
  readonly verifications: VerificationRecord[] = [];
  readonly reservations: ModelCallReservation[] = [];
  readonly usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  denyAfter = Number.POSITIVE_INFINITY;

  async reserveModelCall(input: ModelCallReservation): Promise<BudgetDecision> {
    this.reservations.push(input);
    if (this.reservations.length > this.denyAfter) {
      return {
        allowed: false,
        reason:
          "Model-call budget exhausted after " + this.denyAfter + " call(s) for this orchestration",
      };
    }
    return { allowed: true, reservationId: "reservation-" + this.reservations.length };
  }
  async commitModelUsage(_reservationId: string, actual: TokenUsage): Promise<void> {
    this.usage.inputTokens += actual.inputTokens;
    this.usage.cachedInputTokens += actual.cachedInputTokens;
    this.usage.outputTokens += actual.outputTokens;
  }
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {
    this.events.push(event);
  }
  async upsertTask(task: OrchestrationTask): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }
  async recordApplicationMap(map: ApplicationMapSummary): Promise<void> {
    this.maps.push(map);
  }
  async recordContextPacket(packet: ContextPacketSummary): Promise<void> {
    this.packets.push(packet);
  }
  async recordAttempt(attempt: WorkerAttempt): Promise<void> {
    this.attempts.push(attempt);
  }
  async publishArtifact(artifact: SharedArtifact): Promise<void> {
    this.artifacts.push(artifact);
  }
  async recordVerification(record: VerificationRecord): Promise<void> {
    this.verifications.push(record);
  }

  types(): string[] {
    return this.events.map((event) => event.type);
  }
  find(type: string): Array<Omit<OrchestrationEvent, "id" | "createdAt">> {
    return this.events.filter((event) => event.type === type);
  }
}

interface RunnerScript {
  /** Content the worker writes for a task, by attempt index (1-based). */
  workerFiles: Record<string, Array<{ path: string; content: string }>>;
  artifacts: Record<string, Array<{ name: string; kind: string; payload: string }>>;
  onCall?: (request: RunnerRequest, callNumber: number) => void;
}

class ScriptedCodexRunner implements AgentRunner {
  readonly calls: RunnerRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly attemptsByTask = new Map<string, number>();

  constructor(private readonly script: RunnerScript) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  // The sandbox has no Codex CLI with a model flag, so every role truthfully
  // falls back to the single configured Ark model.
  async supportsModelOverride(): Promise<boolean> {
    return false;
  }
  async cancel(executionId: string): Promise<boolean> {
    this.cancelled.push(executionId);
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls.push({ ...request });
    this.script.onCall?.(request, this.calls.length);
    const usage = { inputTokens: 120, cachedInputTokens: 10, outputTokens: 40 };
    const done = (output: string): RunnerResult => ({ output, threadId: null, usage });

    if (request.role === "planner" && request.prompt.includes("Elaborate the user's intent")) {
      return done(JSON.stringify(INTENT_RESPONSE));
    }
    if (request.role === "planner" && request.prompt.includes("Produce a decomposition")) {
      return done(JSON.stringify(PLAN_RESPONSE));
    }
    if (request.role === "planner") {
      // Direct execution of a confirmed contract.
      await writeFiles(request.workspacePath, [
        { path: "src/api/reset.ts", content: "// IMPLEMENTED direct\n" },
      ]);
      return done("Implemented the reset endpoint directly.");
    }
    if (request.role === "verifier") {
      return done(
        JSON.stringify({ verdict: "pass", summary: "Trusted checks cover the contract", concerns: [] }),
      );
    }
    if (request.role === "integrator") {
      return done(JSON.stringify({ resolutions: [], unresolved: [] }));
    }

    const taskId = request.taskId ?? "unknown";
    if (request.sandboxMode === "read-only") {
      return done(JSON.stringify(preflightFor(taskId)));
    }

    const attempt = (this.attemptsByTask.get(taskId) ?? 0) + 1;
    this.attemptsByTask.set(taskId, attempt);
    const files = this.script.workerFiles[taskId] ?? [];
    await writeFiles(request.workspacePath, files);
    return done(
      JSON.stringify({
        status: "complete",
        summary: "Wrote " + files.length + " file(s) for " + taskId,
        changedFiles: files.map((file) => file.path),
        artifacts: this.script.artifacts[taskId] ?? [],
        checksRun: ["visible-tests"],
        diagnosis: "",
      }),
    );
  }
}

/**
 * Deterministic stand-in for the trusted check runner. Real checks execute an
 * allowlisted argv; this double inspects the candidate workspace instead so the
 * suite needs no Docker, network, Ark or Codex CLI.
 */
class FixtureCommandExecutor implements CommandExecutor {
  readonly calls: Array<{ id: string; cwd: string }> = [];

  async run(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; output: string }> {
    const id = input.args[0] ?? input.command;
    this.calls.push({ id, cwd: input.cwd });
    const bodies = await readAll(input.cwd);

    if (id === "visible-tests") {
      const implemented = bodies.filter(([, body]) => body.includes("IMPLEMENTED"));
      return implemented.length > 0
        ? { exitCode: 0, output: implemented.length + " implemented file(s)" }
        : { exitCode: 1, output: "no implemented file found in this worker workspace" };
    }
    if (id === "protected-acceptance") {
      const byPath = new Map(bodies);
      const required = [
        "src/persistence/schema.ts",
        "src/api/reset.ts",
        "src/web/form.ts",
      ];
      const missing = required.filter(
        (candidate) => !(byPath.get(candidate) ?? "").includes("IMPLEMENTED"),
      );
      const apiBody = byPath.get("src/api/reset.ts") ?? "";
      if (missing.length > 0) {
        return { exitCode: 1, output: "missing acceptance for " + missing.join(", ") };
      }
      if (!apiBody.includes("contract v2")) {
        return { exitCode: 1, output: "api was not refreshed against the current token contract" };
      }
      return { exitCode: 0, output: "hidden acceptance suite passed" };
    }
    return { exitCode: 0, output: "ok" };
  }
}

async function readAll(root: string): Promise<Array<[string, string]>> {
  const results: Array<[string, string]> = [];
  const walk = async (absolute: string, relative: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRelative = relative ? relative + "/" + entry.name : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        results.push([childRelative, await readFile(childAbsolute, "utf8").catch(() => "")]);
      }
    }
  };
  await walk(root, "");
  return results;
}

async function writeFiles(
  root: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const INTENT_RESPONSE = {
  goal: "Add password reset to the application",
  requirements: [
    "Reset tokens expire after 30 minutes",
    "The API validates the token server side",
    "The frontend offers a reset form",
  ],
  assumptions: ["Email delivery already exists"],
  nonGoals: ["Changing the login flow"],
  architectureDecisions: ["Store reset tokens next to the user record"],
  materialQuestions: [],
  manualExpectations: ["The reset email reads clearly"],
  estimate: {
    inputTokenLow: 4_000,
    inputTokenHigh: 20_000,
    outputTokenLow: 800,
    outputTokenHigh: 4_000,
    assumptions: ["Three focused workers"],
  },
};

const PLAN_RESPONSE = {
  decomposable: true,
  reason: "Persistence, API and frontend are separable",
  tasks: [
    {
      key: "persistence",
      title: "Reset token persistence",
      objective: "Add the reset token schema and expiry",
      dependsOn: [],
      allowedPaths: ["src/persistence/**"],
      acceptanceCriterionIds: ["FR-1", "FR-2"],
      requiredArtifacts: [],
      expectedArtifacts: ["reset-token-contract"],
    },
    {
      key: "api",
      title: "Reset API",
      objective: "Add the reset endpoint that validates the token",
      dependsOn: ["persistence"],
      allowedPaths: ["src/api/**"],
      acceptanceCriterionIds: ["FR-1", "FR-2"],
      requiredArtifacts: ["reset-token-contract"],
      expectedArtifacts: [],
    },
    {
      key: "web",
      title: "Reset form",
      objective: "Add the password reset screen",
      dependsOn: [],
      allowedPaths: ["src/web/**"],
      acceptanceCriterionIds: ["FR-1"],
      requiredArtifacts: [],
      expectedArtifacts: ["reset-token-contract"],
    },
  ],
};

function preflightFor(taskId: string): unknown {
  const file = taskId.endsWith("persistence")
    ? "src/persistence/schema.ts"
    : taskId.endsWith("api")
      ? "src/api/reset.ts"
      : "src/web/form.ts";
  return {
    understanding:
      "I will implement the part of password reset that belongs to " + taskId + " only.",
    filesToChange: [file],
    artifactsToConsume: taskId.endsWith("api") ? ["reset-token-contract"] : [],
    artifactsToPublish: taskId.endsWith("api") ? [] : ["reset-token-contract"],
    approach: "Write the file, then run the visible tests.",
    missingContext: [],
    plannedChecks: ["visible-tests"],
  };
}

const CHECK_CATALOG: Record<string, TrustedCheckDefinition> = {
  "FR-1": {
    id: "visible-tests",
    description: "Worker-visible unit tests",
    command: "node",
    args: ["visible-tests"],
    scope: "worker-visible",
  },
  "FR-2": {
    id: "protected-acceptance",
    description: "Hidden acceptance suite held outside worker authority",
    command: "node",
    args: ["protected-acceptance", "--oracle=token-expiry"],
    scope: "protected",
  },
};

const budget = (overrides: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  maxInputTokens: null,
  maxOutputTokens: null,
  maxEstimatedUsd: null,
  maxModelCalls: 60,
  maxSteps: 80,
  maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 2,
  maxWallClockMs: 900_000,
  ...overrides,
});

function makeContract(orchestrationId: string): ExecutionContract {
  return {
    id: "contract-1",
    orchestrationId,
    version: 1,
    intent: {
      id: "draft-1",
      orchestrationId,
      revision: 1,
      goal: INTENT_RESPONSE.goal,
      requirements: INTENT_RESPONSE.requirements,
      assumptions: INTENT_RESPONSE.assumptions,
      nonGoals: INTENT_RESPONSE.nonGoals,
      architectureDecisions: INTENT_RESPONSE.architectureDecisions,
      materialQuestions: [],
      manualExpectations: INTENT_RESPONSE.manualExpectations,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    criteria: [
      {
        id: "FR-1",
        kind: "functional",
        description: "Each area is implemented and its visible tests pass",
        verification: "visible-test",
      },
      {
        id: "FR-2",
        kind: "functional",
        description: "Reset tokens expire and are validated server side",
        verification: "protected-test",
      },
      {
        id: "MAN-1",
        kind: "manual",
        description: "The reset email reads clearly",
        verification: "manual",
      },
    ],
    confirmedBy: "user",
    confirmedAt: "2026-01-01T00:00:00.000Z",
    supersedesContractId: null,
  };
}

function makeOrchestration(
  id: string,
  overrides: Partial<Orchestration> = {},
): Orchestration {
  return {
    id,
    agentId: "agent-1",
    prompt: "Add password reset to the application",
    requestedMode: "auto",
    selectedMode: null,
    status: "ready",
    currentIntentDraftId: "draft-1",
    activeContractId: "contract-1",
    estimate: null,
    budget: budget(),
    usage: {
      byRole: {},
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedUsd: null,
      pricingStatus: "unknown",
    },
    finalOutput: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

const HAPPY_PATH_SCRIPT: RunnerScript = {
  workerFiles: {
    "orc-1:persistence": [
      {
        path: "src/persistence/schema.ts",
        content: "// IMPLEMENTED\nexport interface ResetToken { id: string; expiresAt: string }\n",
      },
    ],
    "orc-1:api": [
      {
        path: "src/api/reset.ts",
        content: "// IMPLEMENTED against reset token contract v2\nexport const reset = () => true;\n",
      },
    ],
    "orc-1:web": [
      { path: "src/web/form.ts", content: "// IMPLEMENTED\nexport const form = () => null;\n" },
    ],
  },
  artifacts: {
    "orc-1:persistence": [
      {
        name: "reset-token-contract",
        kind: "interface",
        payload: "interface ResetToken { id: string; expiresAt: string }",
      },
    ],
    "orc-1:web": [
      {
        name: "reset-token-contract",
        kind: "interface",
        payload:
          "interface ResetToken { id: string; expiresAt: string; singleUse: boolean }",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeHarness(options: {
  script: RunnerScript;
  cleanupPolicy?: "cleanup" | "archive" | "retain";
}): Promise<{
  driver: OrchestrationEngineDriver;
  runner: ScriptedCodexRunner;
  sink: FakeSink;
  executor: FixtureCommandExecutor;
  workspace: string;
  temp: string;
  protectedRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "engine-driver-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const temp = path.join(root, "orchestration-temp");
  const archive = path.join(root, "orchestration-archive");
  const runtimeHomeRoot = path.join(root, "runtime-homes");
  const protectedRoot = path.join(root, "protected-evaluators");

  await mkdir(path.join(workspace, "src", "persistence"), { recursive: true });
  await mkdir(path.join(workspace, "src", "api"), { recursive: true });
  await mkdir(path.join(workspace, "src", "web"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), '{ "name": "app" }\n');
  await writeFile(path.join(workspace, "README.md"), "# App\n");
  await writeFile(
    path.join(workspace, "src", "persistence", "index.ts"),
    "export const users = [];\n",
  );
  await writeFile(path.join(workspace, "src", "api", "index.ts"), "export const routes = [];\n");
  await writeFile(path.join(workspace, "src", "web", "index.ts"), "export const app = 1;\n");
  await writeFile(path.join(workspace, ".env"), "ARK_API_KEY=super-secret-value\n");

  const runner = new ScriptedCodexRunner(options.script);
  const executor = new FixtureCommandExecutor();
  const sink = new FakeSink();
  let counter = 0;

  const driver = new OrchestrationEngineDriver({
    runner,
    tempRoot: temp,
    archiveRoot: archive,
    runtimeHomeRoot,
    protectedEvaluatorRoot: protectedRoot,
    models: {
      fallbackModelId: "ep-ark-default",
      planner: "ep-strong",
      worker: "ep-cheap",
      verifier: "ep-strong",
      integrator: "ep-strong",
    },
    checkCatalog: CHECK_CATALOG,
    cleanupPolicy: options.cleanupPolicy ?? "cleanup",
    commandExecutor: executor,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    idFactory: () => "id-" + ++counter,
  });

  return { driver, runner, sink, executor, workspace, temp, protectedRoot };
}

// ---------------------------------------------------------------------------
// Task 2 acceptance test 1: the full verified multi-worker journey
// ---------------------------------------------------------------------------

describe("Task 2 acceptance: confirmed contract to verified publish", () => {
  it(
    "routes multi-worker, isolates edits, refreshes a stale dependant, integrates deterministically and publishes only after global verification",
    async () => {
      const harness = await makeHarness({ script: HAPPY_PATH_SCRIPT });
      const { driver, runner, sink, executor, workspace, temp, protectedRoot } = harness;
      const controller = new AbortController();
      const orchestration = makeOrchestration("orc-1");
      const contract = makeContract("orc-1");

      // --- intent elaboration ------------------------------------------
      const { draft, estimate } = await driver.elaborateIntent(
        {
          orchestrationId: "orc-1",
          agentId: "agent-1",
          prompt: orchestration.prompt,
          requestedMode: "auto",
          budget: orchestration.budget,
          workspacePath: workspace,
        },
        sink,
        controller.signal,
      );
      expect(draft.goal).toBe(INTENT_RESPONSE.goal);
      expect(draft.requirements).toHaveLength(3);
      expect(estimate.pricingStatus).toBe("unknown");
      expect(estimate.estimatedUsdLow).toBeNull();
      expect(estimate.assumptions.join(" ")).toContain("No model pricing is configured");
      expect(estimate.assumptions.join(" ")).toContain("share the configured Ark model");
      // Intent elaboration is read-only: it must not write code.
      expect(
        runner.calls.filter((call) => call.sandboxMode === "workspace-write"),
      ).toHaveLength(0);

      // --- planning and adaptive routing --------------------------------
      const plan = await driver.plan(
        { orchestration, contract, workspacePath: workspace },
        sink,
        controller.signal,
      );
      expect(plan.selectedMode).toBe("multi-worker");
      expect(plan.routeReason).toContain("modular tasks");
      expect(plan.tasks.map((task) => task.id)).toEqual([
        "orc-1:persistence",
        "orc-1:api",
        "orc-1:web",
      ]);
      expect(plan.tasks[1]?.dependsOn).toEqual(["orc-1:persistence"]);
      expect(plan.tasks[1]?.status).toBe("blocked");
      // Criteria references are filtered against the confirmed contract.
      expect(plan.tasks[2]?.acceptanceCriterionIds).toEqual(["FR-1"]);
      expect(plan.applicationMap.version).toBe(1);
      expect(plan.applicationMap.repositoryHash).toMatch(/^[0-9a-f]{64}$/);

      // --- execution ------------------------------------------------------
      const outcome = await driver.execute(
        { orchestration, contract, workspacePath: workspace, plan },
        sink,
        controller.signal,
      );

      expect(outcome.kind).toBe("completed");
      if (outcome.kind !== "completed") return;
      expect(outcome.finalOutput).toContain("Published 3 file(s)");

      // --- versioned application map --------------------------------------
      expect(sink.maps.map((map) => map.version)).toEqual([1, 2]);
      expect(sink.maps[1]?.repositoryHash).not.toBe(sink.maps[0]?.repositoryHash);

      // --- minimum context packets ----------------------------------------
      expect(sink.packets.length).toBeGreaterThanOrEqual(3);
      for (const packet of sink.packets) {
        expect(packet.sourceFiles.length).toBeLessThanOrEqual(4);
        expect(packet.sourceFiles.map((file) => file.path)).not.toContain(".env");
        expect(packet.estimatedTokens).toBeGreaterThan(0);
      }
      const apiPacket = sink.packets.find((packet) => packet.taskId === "orc-1:api");
      expect(apiPacket?.contractVersion).toBe(1);
      expect(apiPacket?.artifactVersions).toEqual({ "reset-token-contract": 1 });

      // --- preflight always precedes a writable call for the same task -----
      for (const taskId of ["orc-1:persistence", "orc-1:api", "orc-1:web"]) {
        const modes = runner.calls
          .filter((call) => call.taskId === taskId)
          .map((call) => call.sandboxMode);
        expect(modes[0]).toBe("read-only");
        expect(modes).toContain("workspace-write");
      }
      expect(sink.find("preflight.approved")).toHaveLength(4);

      // --- isolated worker workspaces, never the Agent workspace ----------
      const writableCalls = runner.calls.filter(
        (call) => call.sandboxMode === "workspace-write",
      );
      expect(writableCalls.length).toBeGreaterThan(0);
      for (const call of writableCalls) {
        expect(call.workspacePath.startsWith(path.resolve(temp))).toBe(true);
        expect(call.workspacePath).not.toBe(workspace);
      }
      // Distinct tasks receive distinct directories.
      expect(new Set(writableCalls.map((call) => call.workspacePath)).size).toBe(
        writableCalls.length,
      );

      // --- truthful model fallback ----------------------------------------
      const modelCalls = sink.find("model.call");
      expect(modelCalls.length).toBeGreaterThan(0);
      for (const event of modelCalls) {
        expect(event.modelId).toBe("ep-ark-default");
        expect(event.metadata.modelFallback).toBe(true);
      }
      for (const call of runner.calls) {
        expect(call.modelId).toBeUndefined();
        expect(call.orchestrationId).toBe("orc-1");
        expect(call.runtimeHomePath).toBeTruthy();
      }
      // Every logical role really ran.
      expect(new Set(runner.calls.map((call) => call.role))).toEqual(
        new Set(["planner", "worker", "verifier"]),
      );
      // Roles do not share one Codex state directory.
      const homesByRole = new Map(
        runner.calls.map((call) => [call.role, call.runtimeHomePath]),
      );
      expect(new Set(homesByRole.values()).size).toBe(homesByRole.size);

      // --- visible checks ran per task, protected checks only on the candidate
      const visible = sink.verifications.filter((record) => record.scope === "worker-visible");
      expect(visible.length).toBeGreaterThanOrEqual(3);
      expect(visible.every((record) => record.status === "passed")).toBe(true);
      const protectedRecords = sink.verifications.filter(
        (record) => record.scope === "protected",
      );
      expect(protectedRecords).toHaveLength(1);
      expect(protectedRecords[0]).toMatchObject({
        commandOrCheck: "protected-acceptance",
        status: "passed",
        taskId: null,
      });
      expect(protectedRecords[0]?.outputSummary).not.toContain("hidden acceptance suite passed");
      const manual = sink.verifications.filter((record) => record.scope === "manual");
      expect(manual).toHaveLength(1);
      expect(manual[0]).toMatchObject({ commandOrCheck: "MAN-1", status: "skipped" });

      // --- artifact version update and focused dependency refresh ---------
      expect(sink.artifacts.map((artifact) => artifact.name + "@v" + artifact.version)).toEqual([
        "reset-token-contract@v1",
        "reset-token-contract@v2",
      ]);
      const drift = sink.find("artifact.dependency-drift");
      expect(drift).toHaveLength(1);
      expect(drift[0]?.metadata.staleTasks).toBe("orc-1:api");
      const refresh = sink.find("task.stale-refresh");
      expect(refresh).toHaveLength(1);
      expect(refresh[0]?.taskId).toBe("orc-1:api");
      // Only the dependent task re-ran; the unaffected tasks did not.
      const attemptsByTask = new Map<string, number>();
      for (const attempt of sink.attempts) {
        attemptsByTask.set(attempt.taskId, (attemptsByTask.get(attempt.taskId) ?? 0) + 1);
      }
      expect(attemptsByTask.get("orc-1:api")).toBe(2);
      expect(attemptsByTask.get("orc-1:persistence")).toBe(1);
      expect(attemptsByTask.get("orc-1:web")).toBe(1);

      // --- deterministic integration, no integrator model call ------------
      const integration = sink.find("integration.deterministic");
      expect(integration).toHaveLength(1);
      expect(integration[0]?.metadata).toMatchObject({ conflicts: 0, operations: 3 });
      expect(runner.calls.some((call) => call.role === "integrator")).toBe(false);

      // --- verified publish -----------------------------------------------
      expect(sink.find("publication.skipped")).toHaveLength(0);
      const published = sink.find("publication.completed");
      expect(published).toHaveLength(1);
      expect(String(published[0]?.metadata.published).split(",").sort()).toEqual([
        "src/api/reset.ts",
        "src/persistence/schema.ts",
        "src/web/form.ts",
      ]);
      expect(await readFile(path.join(workspace, "src", "web", "form.ts"), "utf8")).toContain(
        "IMPLEMENTED",
      );
      expect(await readFile(path.join(workspace, "src", "api", "reset.ts"), "utf8")).toContain(
        "contract v2",
      );
      // Pre-existing files are untouched.
      expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("# App\n");

      // --- protected evaluator isolation ----------------------------------
      expect(path.resolve(protectedRoot).startsWith(path.resolve(workspace))).toBe(false);
      const protectedFile = await readFile(path.join(protectedRoot, "orc-1.json"), "utf8");
      expect(protectedFile).toContain("protected-acceptance");
      const workerVisiblePaths = runner.calls.map((call) => call.workspacePath);
      for (const candidate of workerVisiblePaths) {
        expect(path.resolve(protectedRoot).startsWith(path.resolve(candidate))).toBe(false);
      }
      // The evaluator argv never reaches the model or the evidence stream.
      const serializedEvidence = JSON.stringify({
        events: sink.events,
        verifications: sink.verifications,
        packets: sink.packets,
        artifacts: sink.artifacts,
      });
      expect(serializedEvidence).not.toContain("--oracle=token-expiry");
      expect(serializedEvidence).not.toContain("super-secret-value");
      for (const call of runner.calls) {
        expect(call.prompt).not.toContain("--oracle=token-expiry");
        expect(call.prompt).not.toContain("super-secret-value");
      }

      // --- cleanup ---------------------------------------------------------
      expect(sink.find("worker.workspace-cleaned").length).toBeGreaterThanOrEqual(4);
      const remaining = await readdir(path.join(temp, "orc-1")).catch(() => []);
      expect(remaining).toEqual([]);

      // --- protected check ran against the staged candidate, not a worker ---
      const protectedCall = executor.calls.find((call) => call.id === "protected-acceptance");
      expect(protectedCall?.cwd).toContain(path.join("orc-1", "staging"));
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Task 2 acceptance test 2: bounded failure, escalation, no publish
// ---------------------------------------------------------------------------

describe("Task 2 acceptance: bounded failure and clean stop", () => {
  it("stops after the attempt budget, escalates a compact packet, publishes nothing and cleans up", async () => {
    const failing: RunnerScript = {
      ...HAPPY_PATH_SCRIPT,
      workerFiles: {
        ...HAPPY_PATH_SCRIPT.workerFiles,
        "orc-1:persistence": [
          { path: "src/persistence/schema.ts", content: "export interface ResetToken {}\n" },
        ],
      },
      artifacts: {},
    };
    const { driver, runner, sink, workspace, temp } = await makeHarness({ script: failing });
    const controller = new AbortController();
    const orchestration = makeOrchestration("orc-1", {
      budget: budget({ maxWorkerAttempts: 2 }),
    });
    const contract = makeContract("orc-1");
    const before = await hashDirectory(workspace);

    const plan = await driver.plan(
      { orchestration, contract, workspacePath: workspace },
      sink,
      controller.signal,
    );
    const outcome = await driver.execute(
      { orchestration, contract, workspacePath: workspace, plan },
      sink,
      controller.signal,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("implementation-bug");
    expect(outcome.reason).toContain("2 bounded attempt(s)");

    // Bounded attempts, not an infinite loop.
    const persistenceAttempts = sink.attempts.filter(
      (attempt) => attempt.taskId === "orc-1:persistence",
    );
    expect(persistenceAttempts).toHaveLength(2);
    expect(persistenceAttempts.every((attempt) => attempt.status === "failed")).toBe(true);
    expect(persistenceAttempts[0]?.errorSummary).toContain("visible-tests");
    expect(persistenceAttempts[0]?.changedFiles).toContain("src/persistence/schema.ts");

    // Compact escalation with a classification.
    const escalation = sink.find("task.escalated");
    expect(escalation).toHaveLength(1);
    expect(escalation[0]?.metadata).toMatchObject({
      classification: "implementation-bug",
      action: "focused-replan",
      attempts: 2,
    });

    // Downstream tasks never ran, and nothing was published.
    expect(sink.attempts.some((attempt) => attempt.taskId === "orc-1:api")).toBe(false);
    expect(sink.find("publication.completed")).toHaveLength(0);
    expect(sink.find("publication.skipped")).toHaveLength(1);
    expect(await hashDirectory(workspace)).toEqual(before);
    expect(sink.artifacts).toHaveLength(0);

    // Temporary state is released even on the failure path.
    expect(sink.find("worker.workspace-cleaned").length).toBeGreaterThanOrEqual(1);
    expect(await readdir(path.join(temp, "orc-1")).catch(() => [])).toEqual([]);
    expect(runner.calls.every((call) => call.executionId.length > 0)).toBe(true);
  });

  it("stops on a budget denial without publishing and reports budget-exhausted", async () => {
    const { driver, sink, workspace } = await makeHarness({ script: HAPPY_PATH_SCRIPT });
    const controller = new AbortController();
    const orchestration = makeOrchestration("orc-1");
    const contract = makeContract("orc-1");
    const before = await hashDirectory(workspace);

    const plan = await driver.plan(
      { orchestration, contract, workspacePath: workspace },
      sink,
      controller.signal,
    );
    // Deny every model call from here on: planning already used one.
    sink.denyAfter = sink.reservations.length;

    const outcome = await driver.execute(
      { orchestration, contract, workspacePath: workspace, plan },
      sink,
      controller.signal,
    );

    expect(outcome.kind).toBe("budget-exhausted");
    if (outcome.kind !== "budget-exhausted") return;
    expect(outcome.reason).toContain("budget exhausted");
    expect(sink.find("budget.denied").length).toBeGreaterThanOrEqual(1);
    expect(sink.find("publication.completed")).toHaveLength(0);
    expect(sink.find("publication.skipped")).toHaveLength(1);
    expect(await hashDirectory(workspace)).toEqual(before);
  });

  it("stops cleanly when the orchestration is cancelled mid-flight", async () => {
    const controller = new AbortController();
    const script: RunnerScript = {
      ...HAPPY_PATH_SCRIPT,
      onCall: (request) => {
        if (request.role === "worker" && request.sandboxMode === "workspace-write") {
          controller.abort();
        }
      },
    };
    const { driver, runner, sink, workspace } = await makeHarness({ script });
    const orchestration = makeOrchestration("orc-1");
    const contract = makeContract("orc-1");
    const before = await hashDirectory(workspace);

    const plan = await driver.plan(
      { orchestration, contract, workspacePath: workspace },
      sink,
      new AbortController().signal,
    );
    const execution = driver.execute(
      { orchestration, contract, workspacePath: workspace, plan },
      sink,
      controller.signal,
    );
    const outcome = await execution;

    expect(outcome.kind).toBe("cancelled");
    expect(sink.find("publication.completed")).toHaveLength(0);
    expect(await hashDirectory(workspace)).toEqual(before);
    // Cancellation after the run has finished is idempotent and safe.
    expect(await driver.cancel("orc-1")).toBe(false);
    expect(runner.cancelled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direct route and workspace drift
// ---------------------------------------------------------------------------

describe("direct route and drift protection", () => {
  it("runs direct execution as a real budgeted, verified path", async () => {
    const script: RunnerScript = { workerFiles: {}, artifacts: {} };
    const { driver, runner, sink, workspace, temp } = await makeHarness({ script });
    const controller = new AbortController();
    const orchestration = makeOrchestration("orc-1", { requestedMode: "direct" });
    const contract: ExecutionContract = {
      ...makeContract("orc-1"),
      criteria: [
        {
          id: "FR-1",
          kind: "functional",
          description: "The endpoint exists",
          verification: "visible-test",
        },
      ],
    };

    const plan = await driver.plan(
      { orchestration, contract, workspacePath: workspace },
      sink,
      controller.signal,
    );
    expect(plan.selectedMode).toBe("direct");
    expect(plan.routeReason).toContain("requested direct execution");
    expect(plan.tasks).toHaveLength(1);

    const outcome = await driver.execute(
      { orchestration, contract, workspacePath: workspace, plan },
      sink,
      controller.signal,
    );

    expect(outcome.kind).toBe("completed");
    // It went through the same reservation, isolation and publish path.
    expect(sink.reservations.some((reservation) => reservation.role === "planner")).toBe(true);
    const writable = runner.calls.filter((call) => call.sandboxMode === "workspace-write");
    expect(writable).toHaveLength(1);
    expect(writable[0]?.workspacePath.startsWith(path.resolve(temp))).toBe(true);
    expect(sink.find("publication.completed")).toHaveLength(1);
    expect(await readFile(path.join(workspace, "src", "api", "reset.ts"), "utf8")).toContain(
      "IMPLEMENTED direct",
    );
    expect(sink.attempts).toHaveLength(1);
  });

  it("refuses to overwrite a file the user changed while the orchestration ran", async () => {
    // The edit happens during the first writable worker call, which is
    // deterministically after the base manifest is captured and well before
    // integration, so the drift is always observed.
    const userEdit: { workspace: string | null } = { workspace: null };
    const script: RunnerScript = {
      ...HAPPY_PATH_SCRIPT,
      onCall: (request) => {
        if (
          request.taskId === "orc-1:persistence" &&
          request.sandboxMode === "workspace-write" &&
          userEdit.workspace
        ) {
          writeFileSync(
            path.join(userEdit.workspace, "src", "web", "form.ts"),
            "// the user wrote this by hand\n",
          );
        }
      },
    };
    const { driver, sink, workspace } = await makeHarness({ script });
    userEdit.workspace = workspace;
    const controller = new AbortController();
    const orchestration = makeOrchestration("orc-1");
    const contract = makeContract("orc-1");

    const plan = await driver.plan(
      { orchestration, contract, workspacePath: workspace },
      sink,
      controller.signal,
    );

    const outcome = await driver.execute(
      { orchestration, contract, workspacePath: workspace, plan },
      sink,
      controller.signal,
    );

    expect(outcome.kind).toBe("needs-user");
    if (outcome.kind !== "needs-user") return;
    expect(outcome.amendment.material).toBe(true);
    expect(outcome.amendment.status).toBe("pending");
    expect(outcome.amendment.reason).toContain("workspace changed");
    expect(sink.find("integration.workspace-drift")).toHaveLength(1);
    // Nothing was overwritten.
    expect(await readFile(path.join(workspace, "src", "web", "form.ts"), "utf8")).toBe(
      "// the user wrote this by hand\n",
    );
    expect(sink.find("publication.completed")).toHaveLength(0);
  });
});
