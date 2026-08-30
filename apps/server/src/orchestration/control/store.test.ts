import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "orchestration-store-test-"));
  temporaryDirectories.push(root);
  return path.join(root, "orchestrations.json");
}

describe("OrchestrationStore", () => {
  it("initializes an empty database when no file exists", async () => {
    const store = new OrchestrationStore(await tempDbPath());
    await store.initialize();
    expect(store.snapshot()).toEqual({
      version: 1,
      orchestrations: [],
      intentDrafts: [],
      contracts: [],
      amendments: [],
      events: [],
      tasks: [],
      applicationMaps: [],
      contextPackets: [],
      attempts: [],
      artifacts: [],
      verifications: [],
    });
  });

  it("reloads persisted data after a fresh initialize", async () => {
    const filePath = await tempDbPath();
    const first = new OrchestrationStore(filePath);
    await first.initialize();
    await first.mutate((db) => {
      db.orchestrations.push({
        id: "orch-1",
        agentId: "agent-1",
        prompt: "add a feature",
        requestedMode: "auto",
        selectedMode: null,
        status: "drafting-intent",
        currentIntentDraftId: null,
        activeContractId: null,
        estimate: null,
        budget: {
          maxInputTokens: null,
          maxOutputTokens: null,
          maxEstimatedUsd: null,
          maxModelCalls: 40,
          maxSteps: 40,
          maxWorkerAttempts: 3,
          maxContextExpansionsPerTask: 3,
          maxWallClockMs: 1_200_000,
        },
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      });
    });

    const second = new OrchestrationStore(filePath);
    await second.initialize();
    expect(second.snapshot().orchestrations).toHaveLength(1);
    expect(second.snapshot().orchestrations[0]?.id).toBe("orch-1");
  });

  it("rejects a corrupted database file rather than silently starting empty", async () => {
    const filePath = await tempDbPath();
    await writeFile(filePath, "{not valid json", "utf8");
    const store = new OrchestrationStore(filePath);
    await expect(store.initialize()).rejects.toThrow();
  });

  it("rejects an unrecognized schema shape", async () => {
    const filePath = await tempDbPath();
    await writeFile(filePath, JSON.stringify({ version: 1, foo: "bar" }), "utf8");
    const store = new OrchestrationStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/format/i);
  });

  it("rejects an unknown future schema version instead of guessing compatibility", async () => {
    const filePath = await tempDbPath();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 99,
        orchestrations: [],
        intentDrafts: [],
        contracts: [],
        amendments: [],
        events: [],
        tasks: [],
        applicationMaps: [],
        contextPackets: [],
        attempts: [],
        artifacts: [],
        verifications: [],
      }),
      "utf8",
    );
    const store = new OrchestrationStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/version/i);
  });

  it("serializes concurrent mutations without losing writes", async () => {
    const store = new OrchestrationStore(await tempDbPath());
    await store.initialize();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.mutate((db) => {
          db.amendments.push({
            id: `amend-${index}`,
            orchestrationId: "orch-1",
            baseContractId: "contract-1",
            proposedIntent: {
              id: `draft-${index}`,
              orchestrationId: "orch-1",
              revision: index,
              goal: "",
              requirements: [],
              assumptions: [],
              nonGoals: [],
              architectureDecisions: [],
              materialQuestions: [],
              manualExpectations: [],
              createdAt: new Date().toISOString(),
            },
            proposedCriteria: null,
            reason: "test",
            material: true,
            status: "pending",
            createdAt: new Date().toISOString(),
            decidedAt: null,
          });
        }),
      ),
    );
    expect(store.snapshot().amendments).toHaveLength(20);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestration-store-fail-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "orchestrations.json");
    const store = new OrchestrationStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "orchestrations.json");
    await expect(
      store.mutate((db) => {
        db.amendments.push({
          id: "orphan",
          orchestrationId: "orch-1",
          baseContractId: "contract-1",
          proposedIntent: {
            id: "draft-orphan",
            orchestrationId: "orch-1",
            revision: 0,
            goal: "",
            requirements: [],
            assumptions: [],
            nonGoals: [],
            architectureDecisions: [],
            materialQuestions: [],
            manualExpectations: [],
            createdAt: new Date().toISOString(),
          },
          proposedCriteria: null,
          reason: "must not become visible",
          material: true,
          status: "pending",
          createdAt: new Date().toISOString(),
          decidedAt: null,
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().amendments).toEqual([]);
  });
});
