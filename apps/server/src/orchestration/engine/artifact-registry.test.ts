import { describe, expect, it } from "vitest";
import type {
  ApplicationMapSummary,
  BudgetDecision,
  ContextPacketSummary,
  ModelCallReservation,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import { ArtifactRegistry } from "./artifact-registry.js";

/** In-memory `OrchestrationSink` double. Test-only, never imported by src. */
class RecordingSink implements OrchestrationSink {
  readonly events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  readonly artifacts: SharedArtifact[] = [];

  async reserveModelCall(_input: ModelCallReservation): Promise<BudgetDecision> {
    return { allowed: true, reservationId: "reservation" };
  }
  async commitModelUsage(_id: string, _actual: TokenUsage): Promise<void> {}
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<void> {
    this.events.push(event);
  }
  async upsertTask(_task: OrchestrationTask): Promise<void> {}
  async recordApplicationMap(_map: ApplicationMapSummary): Promise<void> {}
  async recordContextPacket(_packet: ContextPacketSummary): Promise<void> {}
  async recordAttempt(_attempt: WorkerAttempt): Promise<void> {}
  async publishArtifact(artifact: SharedArtifact): Promise<void> {
    this.artifacts.push(artifact);
  }
  async recordVerification(_record: VerificationRecord): Promise<void> {}
}

const task = (
  id: string,
  requiredArtifactIds: string[],
  observedArtifactVersions: Record<string, number> = {},
): OrchestrationTask => ({
  id,
  orchestrationId: "orc-1",
  title: id,
  objective: "objective",
  status: "passed",
  dependsOn: [],
  allowedPaths: [id + "/**"],
  acceptanceCriterionIds: [],
  requiredArtifactIds,
  observedArtifactVersions,
  applicationMapVersion: 1,
  attemptCount: 1,
});

describe("artifact registry", () => {
  it("versions artifacts by name and persists them through the sink", async () => {
    const sink = new RecordingSink();
    const registry = new ArtifactRegistry({ sink });

    const first = await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-persistence",
      kind: "interface",
      name: "reset-token-contract",
      payload: "interface ResetToken { id: string }",
    });
    const second = await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-web",
      kind: "interface",
      name: "reset-token-contract",
      payload: "interface ResetToken { id: string; expiresAt: string }",
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(registry.latest("reset-token-contract")?.version).toBe(2);
    expect(registry.latestVersions()).toEqual({ "reset-token-contract": 2 });
    expect(sink.artifacts).toHaveLength(2);
    expect(sink.events.map((event) => event.type)).toEqual([
      "artifact.published",
      "artifact.published",
    ]);
  });

  it("truncates an oversized payload instead of storing a whole transcript", async () => {
    const sink = new RecordingSink();
    const registry = new ArtifactRegistry({ sink });
    const artifact = await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-a",
      kind: "decision",
      name: "big",
      payload: "x".repeat(50_000),
    });
    expect(artifact.payload.length).toBe(8_000);
  });

  it("marks only dependent tasks stale on a v1 -> v2 drift", async () => {
    const sink = new RecordingSink();
    const registry = new ArtifactRegistry({ sink });
    await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-persistence",
      kind: "interface",
      name: "reset-token-contract",
      payload: "v1",
    });
    const v2 = await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-web",
      kind: "interface",
      name: "reset-token-contract",
      payload: "v2",
    });

    const tasks = [
      task("task-api", ["reset-token-contract"], { "reset-token-contract": 1 }),
      task("task-docs", []),
      task("task-web", ["reset-token-contract"]),
    ];
    const report = registry.detectDrift(v2, tasks);

    expect(report.staleTaskIds).toEqual(["task-api"]);
    expect(report.unaffectedTaskIds.sort()).toEqual(["task-docs", "task-web"]);
    expect(report.fromVersion).toBe(1);
    expect(report.toVersion).toBe(2);

    await registry.recordDrift("orc-1", report);
    const drift = sink.events.find((event) => event.type === "artifact.dependency-drift");
    expect(drift?.summary).toContain("1 dependent task(s) marked stale");
  });

  it("does not mark a task stale when it already observed the new version", async () => {
    const sink = new RecordingSink();
    const registry = new ArtifactRegistry({ sink });
    await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-persistence",
      kind: "schema",
      name: "reset-token-contract",
      payload: "v1",
    });
    const v2 = await registry.publish({
      orchestrationId: "orc-1",
      producerTaskId: "task-persistence",
      kind: "schema",
      name: "reset-token-contract",
      payload: "v2",
    });
    const report = registry.detectDrift(v2, [
      task("task-api", ["reset-token-contract"], { "reset-token-contract": 2 }),
    ]);
    expect(report.staleTaskIds).toEqual([]);
  });
});
