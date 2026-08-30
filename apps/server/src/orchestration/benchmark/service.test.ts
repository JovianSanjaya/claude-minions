import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkService,
  FileBenchmarkStore,
  FileSystemBenchmarkWorkspaceProvider,
  InMemoryBenchmarkStore,
  armPassedQuality,
  compareArms,
  hashDirectory,
  redactAndBound,
} from "./service.js";
import type { BenchmarkArm, BenchmarkExecutor, BenchmarkRecord } from "./service.js";
import {
  FakeAgentPort,
  FakeWorkspaceProvider,
  RecordingExecutor,
  globalCheckFailed,
  globalCheckPassed,
  protectedCheckPassed,
  result,
  usage,
} from "./fixtures.test.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const directory = temporaryRoots.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "benchmark-test-"));
  temporaryRoots.push(directory);
  return directory;
}

function build(
  executors: Record<BenchmarkArm, BenchmarkExecutor>,
  overrides: {
    workspaces?: FakeWorkspaceProvider;
    store?: InMemoryBenchmarkStore | FileBenchmarkStore;
    agentStatus?: string;
  } = {},
) {
  const workspaces = overrides.workspaces ?? new FakeWorkspaceProvider();
  let counter = 0;
  const service = new BenchmarkService({
    agents: new FakeAgentPort([
      {
        id: AGENT_ID,
        status: overrides.agentStatus ?? "ready",
        workspacePath: "/workspaces/" + AGENT_ID,
      },
    ]),
    workspaces,
    executors,
    ...(overrides.store ? { store: overrides.store } : {}),
    now: () => 1_700_000_000_000 + ++counter * 1_000,
    newId: () => "22222222-2222-4222-8222-22222222222" + (counter % 10),
  });
  return { service, workspaces };
}

describe("benchmark fairness", () => {
  it("runs a deterministic two-arm benchmark from one shared snapshot", async () => {
    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({
        executionId: "exec-direct",
        selectedMode: "direct",
        usage: usage({ inputTokens: 12_000, outputTokens: 900, modelCalls: 1 }),
        counters: { modelCalls: 1, attempts: 1 },
      }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({
        executionId: "exec-orchestrated",
        selectedMode: "multi-worker",
        usage: usage({ inputTokens: 6_000, outputTokens: 1_400, modelCalls: 5 }),
        counters: { modelCalls: 5, attempts: 3, contextExpansions: 1 },
      }),
    });
    const { service, workspaces } = build({ direct, orchestrated });

    const created = await service.create(AGENT_ID, {
      prompt: "Add password reset to the sample application.",
      criteria: [
        {
          id: "c1",
          kind: "functional",
          description: "Reset tokens expire",
          verification: "protected-test",
        },
      ],
    });
    expect(created.status).toBe("running");

    const record = await service.whenSettled(created.id);
    expect(record.status).toBe("completed");
    expect(record.sourceSnapshotHash).toBe("snapshot-hash-aaa");

    // Fairness rule 1: two isolated copies, both from the same source snapshot.
    expect(workspaces.clonedArms).toEqual(["direct", "orchestrated"]);
    expect(record.arms.direct.startedFromSnapshotHash).toBe(record.sourceSnapshotHash);
    expect(record.arms.orchestrated.startedFromSnapshotHash).toBe(
      record.sourceSnapshotHash,
    );
    expect(record.arms.direct.workspaceLabel).not.toBe(
      record.arms.orchestrated.workspaceLabel,
    );

    // Fairness rule 2: identical prompt and criteria in both arms.
    expect(direct.seen[0]?.prompt).toBe(orchestrated.seen[0]?.prompt);
    expect(direct.seen[0]?.criteria).toEqual(orchestrated.seen[0]?.criteria);
    expect(direct.seen[0]?.criteria).not.toBe(orchestrated.seen[0]?.criteria);

    // Fairness rule 3: the second arm receives nothing produced by the first.
    const secondArmInput = JSON.stringify(orchestrated.seen[0], (key, value) =>
      key === "signal" || key === "workspace" ? undefined : value,
    );
    expect(secondArmInput).not.toContain("exec-direct");
    expect(secondArmInput).not.toContain("snapshot-hash");

    // Temporary copies are always released.
    expect(workspaces.disposed).toContain("source");
    expect(workspaces.disposed.length).toBe(3);
  });

  it("reports quality before cost and refuses a cost verdict when quality differs", async () => {
    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({
        executionId: "exec-direct",
        succeeded: true,
        verifications: [globalCheckPassed, protectedCheckPassed],
        usage: usage({ inputTokens: 40_000, outputTokens: 2_000, estimatedUsd: 0.9 }),
      }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({
        executionId: "exec-orchestrated",
        succeeded: false,
        verifications: [globalCheckFailed, protectedCheckPassed],
        usage: usage({ inputTokens: 5_000, outputTokens: 400, estimatedUsd: 0.1 }),
      }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "Rename one constant." });
    const record = await service.whenSettled(created.id);

    expect(record.comparison?.qualityVerdict).toBe("direct-only");
    // Cheaper but worse must never read as a win.
    expect(record.comparison?.costComparable).toBe(false);
    expect(record.comparison?.costVerdict).toBe("not-comparable");
    expect(record.comparison?.tokenVerdict).toBe("not-comparable");
    expect(record.comparison?.warnings.join(" ")).toContain("Cost comparison withheld");
  });

  it("allows direct to win on a small task", async () => {
    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({
        executionId: "exec-direct",
        usage: usage({ inputTokens: 3_000, outputTokens: 200, estimatedUsd: 0.02 }),
      }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({
        executionId: "exec-orchestrated",
        selectedMode: "multi-worker",
        usage: usage({ inputTokens: 21_000, outputTokens: 1_800, estimatedUsd: 0.31 }),
      }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "Fix one typo." });
    const record = await service.whenSettled(created.id);

    expect(record.comparison?.qualityVerdict).toBe("both-passed");
    expect(record.comparison?.costComparable).toBe(true);
    expect(record.comparison?.tokenVerdict).toBe("direct-better");
    expect(record.comparison?.costVerdict).toBe("direct-better");
    expect(record.comparison?.estimatedUsdDelta).toBeCloseTo(0.29, 5);
    expect(record.comparison?.totalTokenDelta).toBe(19_600);
  });

  it("reports unknown pricing instead of fabricating dollars", async () => {
    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({
        executionId: "exec-direct",
        usage: usage({ inputTokens: 9_000, outputTokens: 500, pricing: "unknown" }),
      }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({
        executionId: "exec-orchestrated",
        usage: usage({ inputTokens: 4_000, outputTokens: 700, pricing: "unknown" }),
      }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "Refactor the parser." });
    const record = await service.whenSettled(created.id);

    expect(record.comparison?.pricingStatus).toBe("unknown");
    expect(record.comparison?.costVerdict).toBe("unknown-pricing");
    expect(record.comparison?.estimatedUsdDelta).toBeNull();
    // Tokens are still comparable and reported.
    expect(record.comparison?.tokenVerdict).toBe("orchestrated-better");
    expect(record.arms.direct.usage.totalEstimatedUsd).toBeNull();
  });

  it("warns when arms used different models or different trusted checks", async () => {
    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({
        executionId: "exec-direct",
        verifications: [globalCheckPassed],
        usage: usage({
          role: "planner",
          modelId: "ep-strong",
          inputTokens: 5_000,
          outputTokens: 200,
          estimatedUsd: 0.4,
        }),
      }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({
        executionId: "exec-orchestrated",
        verifications: [protectedCheckPassed],
        usage: usage({
          role: "worker",
          modelId: "ep-cheap",
          inputTokens: 5_000,
          outputTokens: 200,
          estimatedUsd: 0.1,
        }),
      }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "Split the module." });
    const record = await service.whenSettled(created.id);
    const warnings = record.comparison?.warnings.join(" ") ?? "";

    expect(record.comparison?.verificationComparable).toBe(false);
    expect(warnings).toContain("not identical");
    expect(warnings).toContain("ep-strong");
    expect(warnings).toContain("ep-cheap");
    expect(record.comparison?.costComparable).toBe(false);
  });

  it("flags an arm whose isolated copy does not match the source snapshot", async () => {
    const workspaces = new FakeWorkspaceProvider("snapshot-hash-aaa", (arm) =>
      arm === "orchestrated" ? "snapshot-hash-drifted" : "snapshot-hash-aaa",
    );
    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({ executionId: "exec-direct" }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({ executionId: "exec-orchestrated" }),
    });
    const { service } = build({ direct, orchestrated }, { workspaces });
    const created = await service.create(AGENT_ID, { prompt: "Anything." });
    const record = await service.whenSettled(created.id);

    expect(record.comparison?.warnings.join(" ")).toContain(
      "did not start from an identical workspace snapshot",
    );
    expect(record.comparison?.limitations.join(" ")).toContain("did not hash-match");
  });
});

describe("benchmark failure, cancellation, and reload", () => {
  it("records an arm failure without failing the whole benchmark", async () => {
    const direct = new RecordingExecutor("direct", {
      kind: "throw",
      message: "codex exited with ARK_API_KEY=sk-live-abcdefghijklmnop",
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({ executionId: "exec-orchestrated" }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "Break something." });
    const record = await service.whenSettled(created.id);

    expect(record.status).toBe("completed");
    expect(record.arms.direct.status).toBe("failed");
    // The recorded error is redacted before it is persisted.
    expect(record.arms.direct.error).not.toContain("sk-live-abcdefghijklmnop");
    expect(record.arms.direct.error).toContain("[redacted]");
    expect(record.comparison?.qualityVerdict).toBe("orchestrated-only");
  });

  it("cancels a running benchmark and never reports it as a success", async () => {
    const direct = new RecordingExecutor("direct", { kind: "hang" });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({ executionId: "exec-orchestrated" }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "Long task." });

    const record = await service.cancel(created.id);
    expect(record.status).toBe("cancelled");
    expect(record.arms.direct.status).toBe("cancelled");
    expect(record.arms.orchestrated.status).toBe("skipped");
    expect(record.comparison?.qualityVerdict).toBe("incomplete");
    expect(record.comparison?.costComparable).toBe(false);
    expect(direct.cancelled).toContain(created.id);

    // Cancelling twice is safe.
    const again = await service.cancel(created.id);
    expect(again.status).toBe("cancelled");
  });

  it("rejects a second concurrent benchmark and unknown Agents", async () => {
    const direct = new RecordingExecutor("direct", { kind: "hang" });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({ executionId: "exec-orchestrated" }),
    });
    const { service } = build({ direct, orchestrated });
    const created = await service.create(AGENT_ID, { prompt: "First." });

    await expect(service.create(AGENT_ID, { prompt: "Second." })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      service.create("33333333-3333-4333-8333-333333333333", { prompt: "Nope." }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await service.cancel(created.id);
  });

  it("persists and reloads records, reconciling interrupted runs on restart", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "benchmarks.json");
    const store = new FileBenchmarkStore(filePath);
    await store.initialize();

    const direct = new RecordingExecutor("direct", {
      kind: "result",
      result: result({ executionId: "exec-direct" }),
    });
    const orchestrated = new RecordingExecutor("orchestrated", {
      kind: "result",
      result: result({ executionId: "exec-orchestrated" }),
    });
    const { service } = build({ direct, orchestrated }, { store });
    const created = await service.create(AGENT_ID, { prompt: "Persist me." });
    const settled = await service.whenSettled(created.id);
    expect(settled.status).toBe("completed");

    const reloaded = new FileBenchmarkStore(filePath);
    await reloaded.initialize();
    const record = await reloaded.get(created.id);
    expect(record?.status).toBe("completed");
    expect(record?.arms.direct.executionId).toBe("exec-direct");

    // Simulate an interrupted benchmark and prove restart never claims success.
    const interrupted: BenchmarkRecord = structuredClone(record as BenchmarkRecord);
    interrupted.id = "44444444-4444-4444-8444-444444444444";
    interrupted.status = "running";
    interrupted.arms.orchestrated.status = "running";
    await reloaded.put(interrupted);

    const afterRestart = new FileBenchmarkStore(filePath);
    await afterRestart.initialize();
    const reconciled = await afterRestart.get(interrupted.id);
    expect(reconciled?.status).toBe("cancelled");
    expect(reconciled?.arms.orchestrated.status).toBe("cancelled");
    expect(reconciled?.error).toContain("restarted");
  });
});

describe("benchmark helpers", () => {
  it("treats a failing trusted check as a quality failure even if the arm claims success", () => {
    const passed = armPassedQuality({
      arm: "orchestrated",
      status: "succeeded",
      executionId: "e",
      selectedMode: "multi-worker",
      startedFromSnapshotHash: "h",
      workspaceLabel: "l",
      verifications: [globalCheckFailed],
      succeeded: true,
      usage: usage({ inputTokens: 1, outputTokens: 1 }),
      counters: {
        modelCalls: 1,
        attempts: 1,
        contextExpansions: 0,
        escalations: 0,
        integrationFailures: 0,
      },
      wallClockMs: 1,
      finalOutputSummary: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
    expect(passed).toBe(false);
  });

  it("bounds and redacts persisted text", () => {
    expect(redactAndBound("Authorization: Bearer abcdefghijklmnop", 200)).not.toContain(
      "abcdefghijklmnop",
    );
    expect(redactAndBound("x".repeat(50), 10)).toBe("x".repeat(10) + "… [truncated]");
  });

  it("marks an unfinished comparison as incomplete", () => {
    const base = {
      executionId: null,
      selectedMode: null,
      startedFromSnapshotHash: null,
      workspaceLabel: null,
      verifications: [],
      succeeded: false,
      usage: usage({ inputTokens: 0, outputTokens: 0 }),
      counters: {
        modelCalls: 0,
        attempts: 0,
        contextExpansions: 0,
        escalations: 0,
        integrationFailures: 0,
      },
      wallClockMs: 0,
      finalOutputSummary: null,
      error: null,
      startedAt: null,
      completedAt: null,
    } as const;
    const comparison = compareArms(
      { ...base, arm: "direct", status: "succeeded", succeeded: true },
      { ...base, arm: "orchestrated", status: "queued" },
    );
    expect(comparison.qualityVerdict).toBe("incomplete");
    expect(comparison.wallClockVerdict).toBe("not-comparable");
    expect(comparison.totalTokenDelta).toBeNull();
  });
});

describe("filesystem snapshot provider", () => {
  it("clones one source snapshot into two identical isolated copies", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "export const a = 1;\n");
    await mkdir(path.join(workspace, "node_modules", "junk"), { recursive: true });
    await writeFile(path.join(workspace, "node_modules", "junk", "big.js"), "x".repeat(10));
    await writeFile(path.join(workspace, ".env"), "ARK_API_KEY=sk-live-secret\n");

    const provider = new FileSystemBenchmarkWorkspaceProvider(path.join(root, "tmp"));
    const snapshot = await provider.capture({
      benchmarkId: "55555555-5555-4555-8555-555555555555",
      agentId: AGENT_ID,
      workspacePath: workspace,
    });
    const directCopy = await snapshot.clone("direct");
    const orchestratedCopy = await snapshot.clone("orchestrated");

    expect(directCopy.snapshotHash).toBe(snapshot.sourceSnapshotHash);
    expect(orchestratedCopy.snapshotHash).toBe(snapshot.sourceSnapshotHash);
    expect(directCopy.path).not.toBe(orchestratedCopy.path);

    // Secrets and dependency trees never reach an arm copy.
    await expect(hashDirectory(directCopy.path)).resolves.toBe(directCopy.snapshotHash);
    await expect(
      writeFile(path.join(directCopy.path, "src", "index.ts"), "export const a = 2;\n"),
    ).resolves.toBeUndefined();
    await expect(hashDirectory(orchestratedCopy.path)).resolves.toBe(
      snapshot.sourceSnapshotHash,
    );

    await snapshot.dispose();
  });
});
