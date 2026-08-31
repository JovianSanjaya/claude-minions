import type {
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
} from "../contracts.js";

export class ArtifactRegistry {
  private readonly artifacts = new Map<string, SharedArtifact[]>();

  constructor(private readonly sink: OrchestrationSink) {}

  latest(artifactId: string): SharedArtifact | null {
    return this.artifacts.get(artifactId)?.at(-1) ?? null;
  }

  versionsFor(task: OrchestrationTask): Record<string, number> {
    return Object.fromEntries(
      task.requiredArtifactIds.map((id) => [id, this.latest(id)?.version ?? 0]),
    );
  }

  async publish(
    artifact: SharedArtifact,
    tasks: OrchestrationTask[],
  ): Promise<string[]> {
    const versions = this.artifacts.get(artifact.id) ?? [];
    const expected = (versions.at(-1)?.version ?? 0) + 1;
    const existing = versions.find((entry) => entry.version === artifact.version);
    if (existing) {
      if (
        existing.orchestrationId === artifact.orchestrationId &&
        existing.producerTaskId === artifact.producerTaskId &&
        existing.kind === artifact.kind &&
        existing.name === artifact.name &&
        existing.payload === artifact.payload
      ) {
        return [];
      }
      throw new Error(`Artifact ${artifact.id} version ${artifact.version} conflicts with existing content`);
    }
    if (artifact.version !== expected) {
      throw new Error(`Artifact ${artifact.id} must publish version ${expected}`);
    }
    await this.sink.publishArtifact(artifact);
    versions.push(structuredClone(artifact));
    this.artifacts.set(artifact.id, versions);
    await this.sink.recordEvent({
      orchestrationId: artifact.orchestrationId,
      taskId: artifact.producerTaskId,
      executionId: null,
      type: "artifact-published",
      actorRole: "control-plane",
      modelId: null,
      summary: `Published ${artifact.name} v${artifact.version}`,
      metadata: { artifactId: artifact.id, version: artifact.version },
    });
    const stale: string[] = [];
    for (const task of tasks) {
      if (
        task.id !== artifact.producerTaskId &&
        task.requiredArtifactIds.includes(artifact.id) &&
        (task.observedArtifactVersions[artifact.id] ?? 0) < artifact.version
      ) {
        if (["ready", "running", "preflight"].includes(task.status)) {
          task.status = "stale";
          stale.push(task.id);
          await this.sink.upsertTask(task);
          await this.sink.recordEvent({
            orchestrationId: task.orchestrationId,
            taskId: task.id,
            executionId: null,
            type: "dependency-stale",
            actorRole: "control-plane",
            modelId: null,
            summary: `Task became stale after ${artifact.name} v${artifact.version}`,
            metadata: { artifactId: artifact.id, version: artifact.version },
          });
        }
      }
    }
    return stale;
  }

  async refresh(task: OrchestrationTask): Promise<void> {
    for (const artifactId of task.requiredArtifactIds) {
      task.observedArtifactVersions[artifactId] = this.latest(artifactId)?.version ?? 0;
    }
    if (task.status === "stale") task.status = "ready";
    await this.sink.upsertTask(task);
    await this.sink.recordEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      executionId: null,
      type: "dependency-refreshed",
      actorRole: "control-plane",
      modelId: null,
      summary: "Task refreshed only the required artifact versions",
      metadata: { artifactCount: task.requiredArtifactIds.length },
    });
  }
}
