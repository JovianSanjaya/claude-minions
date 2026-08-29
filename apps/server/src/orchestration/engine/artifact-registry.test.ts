import { describe, expect, it } from "vitest";
import type { OrchestrationSink, OrchestrationTask } from "../contracts.js";
import { ArtifactRegistry } from "./artifact-registry.js";

function task(id: string, requiredArtifactIds: string[]): OrchestrationTask {
  return {
    id,
    orchestrationId: "orch",
    title: id,
    objective: id,
    status: "ready",
    dependsOn: [],
    allowedPaths: [id],
    acceptanceCriterionIds: [],
    requiredArtifactIds,
    observedArtifactVersions: {},
    applicationMapVersion: 1,
    attemptCount: 0,
  };
}

describe("artifact registry", () => {
  it("publishes v1 to v2 and refreshes only affected tasks", async () => {
    const affected = task("affected", ["api-contract"]);
    const unaffected = task("unaffected", []);
    const artifacts: unknown[] = [];
    const upserts: OrchestrationTask[] = [];
    const sink = {
      publishArtifact: async (artifact: unknown) => void artifacts.push(artifact),
      upsertTask: async (value: OrchestrationTask) => void upserts.push(structuredClone(value)),
      recordEvent: async () => undefined,
    } as unknown as OrchestrationSink;
    const registry = new ArtifactRegistry();
    const v1 = await registry.publish({
      orchestrationId: "orch",
      producerTaskId: "producer",
      publication: { id: "api-contract", kind: "api", name: "API", payload: "v1" },
      tasks: [affected, unaffected],
      sink,
    });
    expect(v1.artifact.version).toBe(1);
    await registry.refreshTask(affected, "orch", sink);
    affected.status = "ready";
    const v2 = await registry.publish({
      orchestrationId: "orch",
      producerTaskId: "producer",
      publication: { id: "api-contract", kind: "api", name: "API", payload: "v2" },
      tasks: [affected, unaffected],
      sink,
    });
    expect(v2.artifact.version).toBe(2);
    expect(v2.staleTaskIds).toEqual(["affected"]);
    expect(unaffected.status).toBe("ready");
    expect(artifacts).toHaveLength(2);
    expect(upserts.some((value) => value.id === "unaffected")).toBe(false);
  });
});
