import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ApplicationMapSummary,
  BudgetDecision,
  ContextPacketSummary,
  ExecutionContract,
  ModelCallReservation,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import {
  ProcessCommandExecutor,
  VerificationService,
  globalChecks,
  workerVisibleChecks,
  type CommandExecutor,
  type TrustedCheckDefinition,
} from "./verification.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class RecordingSink implements OrchestrationSink {
  readonly verifications: VerificationRecord[] = [];
  async reserveModelCall(_input: ModelCallReservation): Promise<BudgetDecision> {
    return { allowed: true, reservationId: "reservation" };
  }
  async commitModelUsage(_id: string, _actual: TokenUsage): Promise<void> {}
  async recordEvent(_event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {}
  async upsertTask(_task: OrchestrationTask): Promise<void> {}
  async recordApplicationMap(_map: ApplicationMapSummary): Promise<void> {}
  async recordContextPacket(_packet: ContextPacketSummary): Promise<void> {}
  async recordAttempt(_attempt: WorkerAttempt): Promise<void> {}
  async publishArtifact(_artifact: SharedArtifact): Promise<void> {}
  async recordVerification(record: VerificationRecord): Promise<void> {
    this.verifications.push(record);
  }
}

class ScriptedExecutor implements CommandExecutor {
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  constructor(private readonly results: Record<string, { exitCode: number; output: string }>) {}
  async run(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; output: string }> {
    this.calls.push({ command: input.command, args: input.args, cwd: input.cwd });
    return this.results[input.args[0] ?? input.command] ?? { exitCode: 0, output: "ok" };
  }
}

const catalog: Record<string, TrustedCheckDefinition> = {
  "FR-1": {
    id: "visible-tests",
    description: "Worker-visible unit tests",
    command: "node",
    args: ["visible-tests"],
    scope: "worker-visible",
  },
  "FR-2": {
    id: "protected-acceptance",
    description: "Hidden acceptance suite",
    command: "node",
    args: ["protected-acceptance", "--secret-oracle=expiry"],
    scope: "protected",
  },
  "AR-1": {
    id: "global-typecheck",
    description: "Whole-workspace type check",
    command: "node",
    args: ["global-typecheck"],
    scope: "global",
  },
};

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orc-1",
  version: 1,
  intent: {
    id: "draft-1",
    orchestrationId: "orc-1",
    revision: 1,
    goal: "Add password reset",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    materialQuestions: [],
    manualExpectations: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  criteria: [
    { id: "FR-1", kind: "functional", description: "Visible", verification: "visible-test" },
    { id: "FR-2", kind: "functional", description: "Protected", verification: "protected-test" },
    { id: "AR-1", kind: "architectural", description: "Types", verification: "static-check" },
    { id: "FR-3", kind: "functional", description: "Uncovered", verification: "visible-test" },
    { id: "MAN-1", kind: "manual", description: "Looks right to a human", verification: "manual" },
  ],
  confirmedBy: "user",
  confirmedAt: "2026-01-01T00:00:00.000Z",
  supersedesContractId: null,
};

async function makeService(
  executor: CommandExecutor,
): Promise<{ service: VerificationService; sink: RecordingSink; protectedRoot: string; workspace: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "verify-"));
  temporaryDirectories.push(root);
  const protectedRoot = path.join(root, "protected-evaluators");
  const workspace = path.join(root, "workspace");
  const sink = new RecordingSink();
  return {
    sink,
    protectedRoot,
    workspace,
    service: new VerificationService({
      orchestrationId: "orc-1",
      protectedRoot,
      executor,
      sink,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      idFactory: (() => {
        let counter = 0;
        return () => "record-" + ++counter;
      })(),
    }),
  };
}

describe("protected evaluator storage", () => {
  it("installs protected and global checks in mode-0700 trusted storage", async () => {
    const { service, protectedRoot } = await makeService(new ScriptedExecutor({}));
    const installed = await service.installProtectedChecks(contract, catalog);

    expect(installed.map((check) => check.id).sort()).toEqual([
      "global-typecheck",
      "protected-acceptance",
    ]);
    const directory = await stat(protectedRoot);
    expect(directory.mode & 0o777).toBe(0o700);
    const file = await stat(path.join(protectedRoot, "orc-1.json"));
    expect(file.mode & 0o777).toBe(0o600);

    const reloaded = await service.loadProtectedChecks();
    expect(reloaded.map((check) => check.id).sort()).toEqual([
      "global-typecheck",
      "protected-acceptance",
    ]);
  });

  it("never installs a worker-visible check as protected", async () => {
    const { service, protectedRoot } = await makeService(new ScriptedExecutor({}));
    await service.installProtectedChecks(contract, catalog);
    const raw = await readFile(path.join(protectedRoot, "orc-1.json"), "utf8");
    expect(raw).not.toContain("visible-tests");
  });

  it("reports that protected storage lives outside the worker workspace", async () => {
    const { service, workspace } = await makeService(new ScriptedExecutor({}));
    expect(service.isProtectedStorageIsolatedFrom(workspace)).toBe(true);
  });

  it("returns an empty set rather than throwing when storage is absent or corrupt", async () => {
    const { service } = await makeService(new ScriptedExecutor({}));
    expect(await service.loadProtectedChecks()).toEqual([]);
  });
});

describe("running trusted checks", () => {
  it("records a passing worker-visible check with its command", async () => {
    const executor = new ScriptedExecutor({ "visible-tests": { exitCode: 0, output: "3 passed" } });
    const { service, sink } = await makeService(executor);
    const result = await service.runChecks({
      checks: workerVisibleChecks(catalog),
      workspacePath: "/tmp/worker",
      taskId: "task-api",
    });

    expect(result.passed).toBe(true);
    expect(sink.verifications).toHaveLength(1);
    expect(sink.verifications[0]).toMatchObject({
      scope: "worker-visible",
      status: "passed",
      taskId: "task-api",
    });
    expect(sink.verifications[0]?.commandOrCheck).toContain("node");
    expect(sink.verifications[0]?.outputSummary).toContain("3 passed");
  });

  it("never leaks protected evaluator argv or output into evidence", async () => {
    const executor = new ScriptedExecutor({
      "protected-acceptance": { exitCode: 1, output: "expected token.expiresAt < now" },
    });
    const { service, sink } = await makeService(executor);
    const installed = await service.installProtectedChecks(contract, catalog);
    const result = await service.runChecks({
      checks: installed.filter((check) => check.scope === "protected"),
      workspacePath: "/tmp/staging",
      taskId: null,
    });

    expect(result.passed).toBe(false);
    expect(result.failing).toEqual(["protected-acceptance"]);
    const record = sink.verifications.at(-1);
    expect(record?.commandOrCheck).toBe("protected-acceptance");
    expect(record?.commandOrCheck).not.toContain("--secret-oracle");
    expect(record?.outputSummary).not.toContain("expiresAt");
    expect(record?.outputSummary).toContain("characters of output");
  });

  it("truncates a very large worker-visible output", async () => {
    const executor = new ScriptedExecutor({
      "visible-tests": { exitCode: 0, output: "x".repeat(100_000) },
    });
    const { service, sink } = await makeService(executor);
    await service.runChecks({
      checks: workerVisibleChecks(catalog),
      workspacePath: "/tmp/worker",
      taskId: "task-api",
    });
    expect(sink.verifications[0]?.outputSummary).toContain("output truncated");
    expect(sink.verifications[0]?.outputSummary.length).toBeLessThan(4_100);
  });

  it("records manual criteria as explicitly skipped, never as an automated pass", async () => {
    const { service, sink } = await makeService(new ScriptedExecutor({}));
    const records = await service.recordManualCriteria(contract.criteria, null);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ scope: "manual", status: "skipped" });
    expect(sink.verifications[0]?.outputSummary).toContain("Manual acceptance required");
  });

  it("records criteria that have no configured trusted check", async () => {
    const { service, sink } = await makeService(new ScriptedExecutor({}));
    await service.recordUncoveredCriteria(contract, catalog);
    expect(sink.verifications.map((record) => record.commandOrCheck)).toEqual(["FR-3"]);
    expect(sink.verifications[0]?.status).toBe("skipped");
    expect(sink.verifications[0]?.outputSummary).toContain("not verified");
  });

  it("selects checks by scope", () => {
    expect(workerVisibleChecks(catalog).map((check) => check.id)).toEqual(["visible-tests"]);
    expect(globalChecks(catalog).map((check) => check.id)).toEqual(["global-typecheck"]);
  });
});

describe("process command executor", () => {
  it("runs argv only, with no shell interpretation", async () => {
    const executor = new ProcessCommandExecutor();
    const success = await executor.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(success).toEqual({ exitCode: 0, output: "hello" });

    const failure = await executor.run({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(failure.exitCode).toBe(3);

    // A shell metacharacter is an inert argument, not a second command.
    const inert = await executor.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1] ?? '')", "; echo pwned"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(inert.output).not.toContain("pwned\n");
  });
});
