import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionContract, OrchestrationTask } from "../contracts.js";
import { integrate } from "./integrator.js";
import { createFakeAgentRunner, createInMemorySink } from "./test-doubles.js";
import { buildManifest, createTaskWorkspace, diffWorkspace } from "./worker-workspaces.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orch-1",
  version: 1,
  intent: {
    id: "draft-1",
    orchestrationId: "orch-1",
    revision: 0,
    goal: "",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    manualExpectations: [],
    openQuestions: [],
    createdAt: new Date().toISOString(),
  },
  criteria: [],
  confirmedBy: "user",
  confirmedAt: new Date().toISOString(),
  supersedesContractId: null,
};

function task(id: string, allowedPaths: string[]): OrchestrationTask {
  return {
    id,
    orchestrationId: "orch-1",
    title: id,
    objective: "",
    status: "passed",
    dependsOn: [],
    allowedPaths,
    acceptanceCriterionIds: [],
    requiredArtifactIds: [],
    observedArtifactVersions: {},
    applicationMapVersion: 1,
    attemptCount: 1,
  };
}

async function setupMainWorkspace(): Promise<string> {
  const main = await tempDir("integrator-main-");
  await mkdir(path.join(main, "src", "auth"), { recursive: true });
  await mkdir(path.join(main, "src", "email"), { recursive: true });
  await writeFile(path.join(main, "src", "auth", "reset.ts"), "// original\n");
  await writeFile(path.join(main, "src", "email", "send.ts"), "// original\n");
  return main;
}

describe("integrate", () => {
  it("applies non-conflicting worker changes deterministically and publishes after verification passes", async () => {
    const main = await setupMainWorkspace();
    const scratchRoot = await tempDir("integrator-scratch-");
    const baseManifest = await buildManifest(main);

    const workerA = await createTaskWorkspace(scratchRoot, "orch-1", "task-a", main);
    await writeFile(path.join(workerA.path, "src", "auth", "reset.ts"), "// updated by A\n");
    const changedA = await diffWorkspace(workerA);

    const workerB = await createTaskWorkspace(scratchRoot, "orch-1", "task-b", main);
    await writeFile(path.join(workerB.path, "src", "email", "send.ts"), "// updated by B\n");
    const changedB = await diffWorkspace(workerB);

    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({ output: "should not be called", threadId: null, usage: null }));

    const result = await integrate(
      {
        scratchRoot,
        checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
        roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        protectedChecks: [{ name: "protected", scope: "protected" }],
        globalChecks: [{ name: "global", scope: "global" }],
      },
      "orch-1",
      "agent-1",
      contract,
      {
        mainWorkspacePath: main,
        baseManifest,
        workerResults: [
          { task: task("task-a", ["src/auth"]), workspace: workerA, changedFiles: changedA },
          { task: task("task-b", ["src/email"]), workspace: workerB, changedFiles: changedB },
        ],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("published");
    expect(result.conflicts).toEqual([]);
    expect(await readFile(path.join(main, "src", "auth", "reset.ts"), "utf8")).toBe("// updated by A\n");
    expect(await readFile(path.join(main, "src", "email", "send.ts"), "utf8")).toBe("// updated by B\n");
    expect(sink.verifications.length).toBeGreaterThanOrEqual(2);
  });

  it("resolves a genuine conflict via a focused integrator role call scoped to just that file", async () => {
    const main = await setupMainWorkspace();
    const scratchRoot = await tempDir("integrator-scratch-");
    const baseManifest = await buildManifest(main);

    const workerA = await createTaskWorkspace(scratchRoot, "orch-1", "task-a", main);
    await writeFile(path.join(workerA.path, "src", "auth", "reset.ts"), "// A's version\n");
    const changedA = await diffWorkspace(workerA);

    const workerB = await createTaskWorkspace(scratchRoot, "orch-1", "task-b", main);
    await writeFile(path.join(workerB.path, "src", "auth", "reset.ts"), "// B's version\n");
    const changedB = await diffWorkspace(workerB);

    const sink = createInMemorySink();
    let sawBothVersions = false;
    const runner = createFakeAgentRunner(async (request) => {
      sawBothVersions = request.prompt.includes("A's version") && request.prompt.includes("B's version");
      await writeFile(path.join(request.workspacePath, "src", "auth", "reset.ts"), "// reconciled\n");
      return { output: "reconciled", threadId: null, usage: null };
    });

    const result = await integrate(
      {
        scratchRoot,
        checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
        roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        protectedChecks: [],
        globalChecks: [{ name: "global", scope: "global" }],
      },
      "orch-1",
      "agent-1",
      contract,
      {
        mainWorkspacePath: main,
        baseManifest,
        workerResults: [
          { task: task("task-a", ["src/auth"]), workspace: workerA, changedFiles: changedA },
          { task: task("task-b", ["src/auth"]), workspace: workerB, changedFiles: changedB },
        ],
      },
      new AbortController().signal,
    );

    expect(sawBothVersions).toBe(true);
    expect(result.status).toBe("published");
    expect(result.conflicts).toEqual(["src/auth/reset.ts"]);
    expect(await readFile(path.join(main, "src", "auth", "reset.ts"), "utf8")).toBe("// reconciled\n");
  });

  it("detects main-workspace drift and halts without touching the workspace", async () => {
    const main = await setupMainWorkspace();
    const scratchRoot = await tempDir("integrator-scratch-");
    const baseManifest = await buildManifest(main);

    // the user edits the main workspace while a worker is "in flight"
    await writeFile(path.join(main, "src", "auth", "reset.ts"), "// user edited this directly\n");

    const worker = await createTaskWorkspace(scratchRoot, "orch-1", "task-a", main);
    await writeFile(path.join(worker.path, "src", "email", "send.ts"), "// worker change\n");
    const changed = await diffWorkspace(worker);

    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({ output: "n/a", threadId: null, usage: null }));

    const result = await integrate(
      {
        scratchRoot,
        checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
        roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        protectedChecks: [],
        globalChecks: [],
      },
      "orch-1",
      "agent-1",
      contract,
      { mainWorkspacePath: main, baseManifest, workerResults: [{ task: task("task-a", ["src/email"]), workspace: worker, changedFiles: changed }] },
      new AbortController().signal,
    );

    expect(result.status).toBe("drift");
    // main workspace's user edit is preserved untouched, and the worker change was never applied
    expect(await readFile(path.join(main, "src", "auth", "reset.ts"), "utf8")).toBe(
      "// user edited this directly\n",
    );
    expect(await readFile(path.join(main, "src", "email", "send.ts"), "utf8")).toBe("// original\n");
  });

  it("leaves the main workspace unchanged when global verification fails on the staged candidate", async () => {
    const main = await setupMainWorkspace();
    const scratchRoot = await tempDir("integrator-scratch-");
    const baseManifest = await buildManifest(main);

    const worker = await createTaskWorkspace(scratchRoot, "orch-1", "task-a", main);
    await writeFile(path.join(worker.path, "src", "auth", "reset.ts"), "// broken change\n");
    const changed = await diffWorkspace(worker);

    const sink = createInMemorySink();
    const runner = createFakeAgentRunner(() => ({ output: "n/a", threadId: null, usage: null }));

    const result = await integrate(
      {
        scratchRoot,
        checkRunner: async () => ({ status: "failed", outputSummary: "global suite failed" }),
        roleDeps: { runner, sink, modelIds: {}, defaultModelId: "ep-default" },
        protectedChecks: [],
        globalChecks: [{ name: "global", scope: "global" }],
      },
      "orch-1",
      "agent-1",
      contract,
      { mainWorkspacePath: main, baseManifest, workerResults: [{ task: task("task-a", ["src/auth"]), workspace: worker, changedFiles: changed }] },
      new AbortController().signal,
    );

    expect(result.status).toBe("verification-failed");
    // published nothing to the real Agent workspace
    expect(await readFile(path.join(main, "src", "auth", "reset.ts"), "utf8")).toBe("// original\n");
  });
});
