import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OrchestrationStore } from "./store.js";

describe("OrchestrationStore", () => {
  it("creates a deterministic empty database and reloads it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-control-store-"));
    const file = path.join(directory, "orchestrations.json");
    const store = new OrchestrationStore(file);
    await store.initialize();
    expect(store.snapshot()).toMatchObject({ version: 1, orchestrations: [], events: [] });
    const reloaded = new OrchestrationStore(file);
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(store.snapshot());
  });

  it("rejects corrupted and unknown future versions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-control-bad-"));
    const file = path.join(directory, "orchestrations.json");
    await writeFile(file, "not-json", { mode: 0o600 });
    await expect(new OrchestrationStore(file).initialize()).rejects.toThrow();
    await writeFile(file, JSON.stringify({ version: 99 }), { mode: 0o600 });
    await expect(new OrchestrationStore(file).initialize()).rejects.toThrow(
      "Unsupported orchestration database version: 99",
    );
  });

  it("serializes mutations and keeps the prior snapshot after a failed persist", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-control-queue-"));
    const file = path.join(directory, "orchestrations.json");
    let writes = 0;
    const store = new OrchestrationStore(file, async (target, data) => {
      writes += 1;
      if (writes === 4) throw new Error("disk unavailable");
      await writeFile(target, data, { mode: 0o600 });
    });
    await store.initialize();
    await Promise.all([
      store.mutate((database) => {
        database.benchmarkReferences.push({ order: 1 });
      }),
      store.mutate((database) => {
        database.benchmarkReferences.push({ order: 2 });
      }),
    ]);
    expect(store.snapshot().benchmarkReferences).toHaveLength(2);
    await expect(
      store.mutate((database) => {
        database.benchmarkReferences.push({ order: 3 });
      }),
    ).rejects.toThrow("disk unavailable");
    expect(store.snapshot().benchmarkReferences).toHaveLength(2);
    await store.mutate((database) => {
      database.benchmarkReferences.push({ order: 4 });
    });
    expect(store.snapshot().benchmarkReferences).toHaveLength(3);
  });

  it("redacts recursively before writing to disk and returning a snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-control-redact-"));
    const file = path.join(directory, "orchestrations.json");
    const store = new OrchestrationStore(file);
    await store.initialize();
    await store.mutate((database) => {
      database.benchmarkReferences.push({
        authorization: "Bearer super-secret-value",
        nested: { password: "hunter2", note: "ARK_API_KEY=secret-key-value" },
      });
    });
    const disk = await readFile(file, "utf8");
    expect(disk).not.toContain("super-secret-value");
    expect(disk).not.toContain("hunter2");
    expect(disk).not.toContain("secret-key-value");
    expect(JSON.stringify(store.snapshot())).toContain("[REDACTED]");
  });
});
