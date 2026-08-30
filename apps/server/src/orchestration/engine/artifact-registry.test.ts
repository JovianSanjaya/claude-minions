import { describe, expect, it } from "vitest";
import { createArtifactRegistry, detectStaleTasks } from "./artifact-registry.js";
import { createInMemorySink } from "./test-doubles.js";

describe("createArtifactRegistry", () => {
  it("versions a named artifact starting at 1 and increments on each publish", async () => {
    const sink = createInMemorySink();
    const registry = createArtifactRegistry("orch-1", sink);
    const v1 = await registry.publish("interface", "reset-token-schema", "v1 payload", "task-a");
    expect(v1.version).toBe(1);
    const v2 = await registry.publish("interface", "reset-token-schema", "v2 payload", "task-a");
    expect(v2.version).toBe(2);
    expect(registry.latestVersion("reset-token-schema")).toBe(2);
    expect(sink.artifacts).toHaveLength(2);
  });

  it("tracks independent version counters per artifact name", async () => {
    const sink = createInMemorySink();
    const registry = createArtifactRegistry("orch-1", sink);
    await registry.publish("interface", "schema-a", "x", "task-a");
    await registry.publish("interface", "schema-b", "y", "task-b");
    await registry.publish("interface", "schema-a", "x2", "task-a");
    expect(registry.latestVersion("schema-a")).toBe(2);
    expect(registry.latestVersion("schema-b")).toBe(1);
  });
});

describe("detectStaleTasks: v1 -> v2 drift refreshes only affected dependent work", () => {
  it("flags only the task that depends on the artifact that changed, leaving an unaffected task alone", () => {
    const tasks = [
      {
        id: "task-dependent",
        observedArtifactVersions: { "reset-token-schema": 1 },
        requiredArtifactIds: ["reset-token-schema"],
      },
      {
        id: "task-unaffected",
        observedArtifactVersions: {},
        requiredArtifactIds: [],
      },
      {
        id: "task-already-current",
        observedArtifactVersions: { "reset-token-schema": 2 },
        requiredArtifactIds: ["reset-token-schema"],
      },
    ];
    const stale = detectStaleTasks(tasks, { "reset-token-schema": 2 });
    expect(stale).toEqual(["task-dependent"]);
  });

  it("returns nothing stale when no artifact has advanced past what a task observed", () => {
    const tasks = [{ id: "task-a", observedArtifactVersions: { schema: 1 }, requiredArtifactIds: ["schema"] }];
    expect(detectStaleTasks(tasks, { schema: 1 })).toEqual([]);
  });
});
