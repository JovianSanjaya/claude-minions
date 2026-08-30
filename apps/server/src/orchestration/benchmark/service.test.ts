import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContractCriterion } from "../contracts.js";
import {
  BenchmarkService,
  interpretBenchmark,
  type AgentWorkspaceLookup,
  type BenchmarkArmResult,
  type BenchmarkExecutor,
  type BenchmarkRunInput,
} from "./service.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function criterion(id: string, description: string): ContractCriterion {
  return { id, kind: "functional", description, verification: "visible-test", provenance: "user-explicit", sourceClaimId: null };
}

function armResult(overrides: Partial<BenchmarkArmResult> = {}): BenchmarkArmResult {
  return {
    mode: "direct",
    modelIds: { worker: "ep-default" },
    success: true,
    verificationSummary: "all checks passed",
    totalInputTokens: 100,
    totalCachedInputTokens: 0,
    totalOutputTokens: 50,
    estimatedUsd: null,
    pricingStatus: "unknown",
    wallClockMs: 1000,
    modelCalls: 1,
    attempts: 1,
    contextExpansions: 0,
    escalations: 0,
    integrationFailures: 0,
    error: null,
    ...overrides,
  };
}

function fakeExecutor(handler: (input: BenchmarkRunInput) => BenchmarkArmResult | Promise<BenchmarkArmResult>): BenchmarkExecutor {
  return { run: (input) => Promise.resolve(handler(input)) };
}

function agentLookup(workspacePath: string): AgentWorkspaceLookup {
  return { getWorkspacePath: (agentId) => (agentId === "agent-1" ? workspacePath : null) };
}

const criteria = [criterion("c1", "Add password reset")];

describe("BenchmarkService: fairness", () => {
  it("creates two isolated copies from the same source snapshot, and neither arm sees the other's workspace", async () => {
    const source = await tempDir("bench-source-");
    await writeFile(path.join(source, "a.ts"), "export const a = 1;\n");
    const scratchRoot = await tempDir("bench-scratch-");

    const seenPaths: string[] = [];
    const executor = (mode: "direct" | "orchestrated") =>
      fakeExecutor((input) => {
        seenPaths.push(input.workspacePath);
        return armResult({ mode });
      });

    const service = new BenchmarkService(agentLookup(source), executor("direct"), executor("orchestrated"), scratchRoot);
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "Add password reset", criteria });
    await service.waitForPendingWork(record.id);

    const final = service.getBenchmark(record.id);
    expect(final.status).toBe("completed");
    expect(seenPaths).toHaveLength(2);
    expect(new Set(seenPaths).size).toBe(2); // two genuinely distinct workspace paths
    expect(seenPaths.every((p) => p !== source)).toBe(true); // neither arm touches the original workspace
  });

  it("passes the identical prompt and criteria to both arms", async () => {
    const source = await tempDir("bench-source-");
    await writeFile(path.join(source, "a.ts"), "x");
    const scratchRoot = await tempDir("bench-scratch-");
    const seen: BenchmarkRunInput[] = [];
    const executor = fakeExecutor((input) => {
      seen.push(input);
      return armResult();
    });
    const service = new BenchmarkService(agentLookup(source), executor, executor, scratchRoot);
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "Add password reset", criteria });
    await service.waitForPendingWork(record.id);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.prompt).toBe(seen[1]?.prompt);
    expect(seen[0]?.criteria).toEqual(seen[1]?.criteria);
  });

  it("records a comparability warning when the arms used different models", async () => {
    const source = await tempDir("bench-source-");
    await writeFile(path.join(source, "a.ts"), "x");
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(
      agentLookup(source),
      fakeExecutor(() => armResult({ mode: "direct", modelIds: { worker: "ep-strong" } })),
      fakeExecutor(() => armResult({ mode: "orchestrated", modelIds: { worker: "ep-cheap" } })),
      scratchRoot,
    );
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "x", criteria });
    await service.waitForPendingWork(record.id);
    const final = service.getBenchmark(record.id);
    expect(final.comparabilityWarnings.some((w) => w.includes("Different underlying models"))).toBe(true);
  });

  it("flags quality difference instead of silently comparing cost when only one arm succeeds", async () => {
    const source = await tempDir("bench-source-");
    await writeFile(path.join(source, "a.ts"), "x");
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(
      agentLookup(source),
      fakeExecutor(() => armResult({ mode: "direct", success: true, estimatedUsd: 0.5, pricingStatus: "configured" })),
      fakeExecutor(() => armResult({ mode: "orchestrated", success: false, estimatedUsd: 0.1, pricingStatus: "configured" })),
      scratchRoot,
    );
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "x", criteria });
    await service.waitForPendingWork(record.id);
    const final = service.getBenchmark(record.id);
    expect(final.comparabilityWarnings.some((w) => w.includes("Quality differs"))).toBe(true);
    expect(interpretBenchmark(final).safeToCompareCost).toBe(false);
  });

  it("allows direct to win when both succeed and direct is cheaper", async () => {
    const source = await tempDir("bench-source-");
    await writeFile(path.join(source, "a.ts"), "x");
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(
      agentLookup(source),
      fakeExecutor(() => armResult({ mode: "direct", success: true, estimatedUsd: 0.05, pricingStatus: "configured" })),
      fakeExecutor(() => armResult({ mode: "orchestrated", success: true, estimatedUsd: 0.4, pricingStatus: "configured" })),
      scratchRoot,
    );
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "x", criteria });
    await service.waitForPendingWork(record.id);
    const final = service.getBenchmark(record.id);
    const { verdict, safeToCompareCost } = interpretBenchmark(final);
    expect(safeToCompareCost).toBe(true);
    expect(verdict).toMatch(/direct was cheaper/i);
  });

  it("compares tokens only (never a dollar claim) when pricing is unknown for either arm", async () => {
    const source = await tempDir("bench-source-");
    await writeFile(path.join(source, "a.ts"), "x");
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(
      agentLookup(source),
      fakeExecutor(() => armResult({ mode: "direct", success: true, pricingStatus: "unknown" })),
      fakeExecutor(() => armResult({ mode: "orchestrated", success: true, pricingStatus: "configured", estimatedUsd: 0.2 })),
      scratchRoot,
    );
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "x", criteria });
    await service.waitForPendingWork(record.id);
    const final = service.getBenchmark(record.id);
    expect(interpretBenchmark(final).safeToCompareCost).toBe(false);
  });
});

describe("BenchmarkService: validation and lifecycle", () => {
  it("rejects an unknown Agent and an empty prompt/criteria", async () => {
    const source = await tempDir("bench-source-");
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(
      agentLookup(source),
      fakeExecutor(() => armResult()),
      fakeExecutor(() => armResult()),
      scratchRoot,
    );
    await expect(
      service.createBenchmark({ agentId: "unknown-agent", prompt: "x", criteria }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.createBenchmark({ agentId: "agent-1", prompt: "", criteria })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(service.createBenchmark({ agentId: "agent-1", prompt: "x", criteria: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("getBenchmark 404s for an unknown id", async () => {
    const source = await tempDir("bench-source-");
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(agentLookup(source), fakeExecutor(() => armResult()), fakeExecutor(() => armResult()), scratchRoot);
    expect(() => service.getBenchmark("does-not-exist")).toThrow();
  });

  it("returns a running record immediately (202-style) before the background comparison finishes", async () => {
    const source = await tempDir("bench-source-");
    await mkdir(source, { recursive: true });
    const scratchRoot = await tempDir("bench-scratch-");
    const service = new BenchmarkService(
      agentLookup(source),
      fakeExecutor(() => new Promise<never>(() => undefined)),
      fakeExecutor(() => armResult()),
      scratchRoot,
    );
    const record = await service.createBenchmark({ agentId: "agent-1", prompt: "x", criteria });
    expect(record.status).toBe("running");
    expect(record.direct).toBeNull();
  });
});
