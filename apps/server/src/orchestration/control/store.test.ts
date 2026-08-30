import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Orchestration } from "../contracts.js";
import { DEFAULT_BUDGET_POLICY, emptyUsageLedger } from "./budget-ledger.js";
import {
  emptyOrchestrationDatabase,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationStore,
  OrchestrationStoreError,
} from "./store.js";

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "orchestration-store-"));
  filePath = path.join(directory, "orchestrations.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function makeOrchestration(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    prompt: "Add password reset",
    requestedMode: "auto",
    selectedMode: null,
    status: "drafting-intent",
    currentIntentDraftId: null,
    activeContractId: null,
    estimate: null,
    budget: DEFAULT_BUDGET_POLICY,
    usage: emptyUsageLedger(false),
    finalOutput: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("OrchestrationStore", () => {
  it("initializes a deterministic empty database and persists it", async () => {
    const store = new OrchestrationStore(filePath);
    await store.initialize();

    expect(store.snapshot()).toEqual(emptyOrchestrationDatabase());
    const raw = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
    expect(raw.version).toBe(ORCHESTRATION_SCHEMA_VERSION);
  });

  it("survives a reload with the same content", async () => {
    const first = new OrchestrationStore(filePath);
    await first.initialize();
    await first.mutate((database) => {
      database.orchestrations.push(makeOrchestration());
    });

    const second = new OrchestrationStore(filePath);
    await second.initialize();
    expect(second.snapshot().orchestrations).toHaveLength(1);
    expect(second.snapshot().orchestrations[0]?.prompt).toBe("Add password reset");
  });

  it("rejects a database written by a newer schema version", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ ...emptyOrchestrationDatabase(), version: 99 }),
      "utf8",
    );
    const store = new OrchestrationStore(filePath);
    await expect(store.initialize()).rejects.toBeInstanceOf(OrchestrationStoreError);
    await expect(store.initialize()).rejects.toThrow(/newer than this build supports/);
  });

  it("rejects corrupted JSON instead of silently discarding evidence", async () => {
    await writeFile(filePath, "{ this is not json", "utf8");
    const store = new OrchestrationStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/not valid JSON/);
  });

  it("rejects structurally invalid content", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ ...emptyOrchestrationDatabase(), orchestrations: "nope" }),
      "utf8",
    );
    const store = new OrchestrationStore(filePath);
    await expect(store.initialize()).rejects.toThrow(/failed validation/);
  });

  it("refuses to mutate before initialize()", async () => {
    const store = new OrchestrationStore(filePath);
    await expect(store.mutate(() => undefined)).rejects.toThrow(/before initialize/);
  });

  it("serializes concurrent mutations", async () => {
    const store = new OrchestrationStore(filePath);
    await store.initialize();

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        store.mutate((database) => {
          // Read-modify-write: a lost update would leave gaps in the ids.
          const next = database.events.length;
          database.events.push({
            id: "event-" + next,
            orchestrationId: "orchestration-" + index,
            taskId: null,
            executionId: null,
            type: "test.event",
            actorRole: "control-plane",
            modelId: null,
            summary: "entry " + next,
            metadata: {},
            createdAt: "2026-01-01T00:00:00.000Z",
          });
        }),
      ),
    );

    const events = store.snapshot().events;
    expect(events).toHaveLength(25);
    expect(events.map((event) => event.id)).toEqual(
      Array.from({ length: 25 }, (_unused, index) => "event-" + index),
    );
  });

  it("keeps the previous consistent state when a write fails", async () => {
    const store = new OrchestrationStore(filePath);
    await store.initialize();
    await store.mutate((database) => {
      database.orchestrations.push(makeOrchestration());
    });

    // Make the temporary write target unusable so persist() rejects.
    await mkdir(filePath + ".tmp", { recursive: true });

    await expect(
      store.mutate((database) => {
        database.orchestrations.push(
          makeOrchestration({ id: "33333333-3333-4333-8333-333333333333" }),
        );
      }),
    ).rejects.toBeTruthy();

    expect(store.snapshot().orchestrations).toHaveLength(1);

    // The queue recovers: later mutations still work once writing is possible.
    await rm(filePath + ".tmp", { recursive: true, force: true });
    await store.mutate((database) => {
      database.orchestrations.push(
        makeOrchestration({ id: "44444444-4444-4444-8444-444444444444" }),
      );
    });
    expect(store.snapshot().orchestrations).toHaveLength(2);

    const reloaded = new OrchestrationStore(filePath);
    await reloaded.initialize();
    expect(reloaded.snapshot().orchestrations).toHaveLength(2);
  });

  it("redacts secrets before they reach disk", async () => {
    const store = new OrchestrationStore(filePath);
    await store.initialize();
    await store.mutate((database) => {
      database.orchestrations.push(
        makeOrchestration({
          prompt: "deploy with ARK_API_KEY=ark-live-super-secret-value please",
        }),
      );
      database.events.push({
        id: "event-secret",
        orchestrationId: "11111111-1111-4111-8111-111111111111",
        taskId: null,
        executionId: null,
        type: "test.event",
        actorRole: "control-plane",
        modelId: null,
        summary: "called with Authorization: Bearer abcdef0123456789 header",
        metadata: { note: "password=hunter2000" },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    const onDisk = await readFile(filePath, "utf8");
    expect(onDisk).not.toContain("ark-live-super-secret-value");
    expect(onDisk).not.toContain("abcdef0123456789");
    expect(onDisk).not.toContain("hunter2000");
    expect(onDisk).toContain("[redacted]");

    // The in-memory state matches what was written, not the raw input.
    expect(store.snapshot().orchestrations[0]?.prompt).not.toContain(
      "ark-live-super-secret-value",
    );
  });

  it("writes the database with owner-only permissions", async () => {
    const store = new OrchestrationStore(filePath);
    await store.initialize();
    const { stat } = await import("node:fs/promises");
    const stats = await stat(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
