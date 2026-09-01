import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BenchmarkService, BenchmarkStore, type BenchmarkExecutor } from "./service.js";

const roots: string[] = [];
const waitFor = async (service: BenchmarkService, id: string) => {
  for (let index = 0; index < 50; index += 1) {
    const value = service.get(id);
    if (value.status !== "running") return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("benchmark timed out");
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("BenchmarkService", () => {
  it("uses identical snapshot, prompt, and criteria for isolated arms and reloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "benchmark-")); roots.push(root);
    const calls: Array<{ mode: string; workspacePath: string; prompt: string; criteria: unknown }> = [];
    const executor: BenchmarkExecutor = { execute: async (input) => {
      calls.push(input);
      return { executionId: input.mode, success: true, verificationPassed: true, verificationSummary: "same checks passed", modelIds: [input.mode], logicalRoles: [input.mode === "direct" ? "planner" : "worker"], usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 }, estimatedUsd: null, wallClockMs: 3, calls: 1, attempts: 1, contextExpansions: 0, escalations: 0, integrationFailures: 0, outputSummary: "done", error: null };
    }};
    const store = new BenchmarkStore(path.join(root, "benchmarks.json"));
    const service = new BenchmarkService(store, { snapshot: async () => ({ hash: "same-hash", createIsolatedCopy: async (label) => path.join(root, label), cleanup: async () => undefined }) }, executor);
    await service.initialize();
    const created = await service.create("agent", "same prompt", [{ id: "c1", kind: "functional", description: "works", verification: "visible-test" }]);
    const complete = await waitFor(service, created.id);
    expect(complete.status).toBe("completed");
    expect(calls.map((call) => call.prompt)).toEqual(["same prompt", "same prompt"]);
    expect(new Set(calls.map((call) => call.workspacePath)).size).toBe(2);
    expect(calls[0]?.criteria).toEqual(calls[1]?.criteria);
    const reloaded = new BenchmarkService(new BenchmarkStore(path.join(root, "benchmarks.json")), { snapshot: async () => { throw new Error("unused"); } }, executor);
    await reloaded.initialize();
    expect(reloaded.get(created.id).snapshotHash).toBe("same-hash");
  });

  it("persists a failed arm without exposing the other arm to its output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "benchmark-failure-")); roots.push(root);
    const store = new BenchmarkStore(path.join(root, "benchmarks.json"));
    const service = new BenchmarkService(store, { snapshot: async () => ({ hash: "h", createIsolatedCopy: async (label) => path.join(root, label), cleanup: async () => undefined }) }, { execute: async ({ mode }) => { throw new Error(`${mode} fixture failure`); } });
    await service.initialize();
    const created = await service.create("agent", "prompt", [{ id: "c", kind: "functional", description: "works", verification: "visible-test" }]);
    const failed = await waitFor(service, created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/fixture failure/);
    const reloaded = new BenchmarkService(new BenchmarkStore(path.join(root, "benchmarks.json")), { snapshot: async () => { throw new Error("unused"); } }, { execute: async () => { throw new Error("unused"); } });
    await reloaded.initialize();
    expect(reloaded.get(created.id).status).toBe("failed");
  });
});
