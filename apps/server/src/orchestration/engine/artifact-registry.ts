import { randomUUID } from "node:crypto";
import type {
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
} from "../contracts.js";

export interface ArtifactPublication {
  id?: string;
  kind: SharedArtifact["kind"];
  name: string;
  payload: string;
}

export class ArtifactRegistry {
  private readonly artifacts = new Map<string, SharedArtifact[]>();

  list(orchestrationId: string): SharedArtifact[] {
    return [...(this.artifacts.get(orchestrationId) ?? [])];
  }

  latest(orchestrationId: string, idOrName: string): SharedArtifact | undefined {
    return this.list(orchestrationId)
      .filter((artifact) => artifact.id === idOrName || artifact.name === idOrName)
      .sort((left, right) => right.version - left.version)[0];
  }

  async publish(input: {
    orchestrationId: string;
    producerTaskId: string;
    publication: ArtifactPublication;
    tasks: OrchestrationTask[];
    sink: OrchestrationSink;
  }): Promise<{ artifact: SharedArtifact; staleTaskIds: string[] }> {
    const id = input.publication.id ?? `artifact-${input.publication.name.replace(/[^a-zA-Z0-9_.-]/g, "-") || randomUUID()}`;
    const previous = this.latest(input.orchestrationId, id);
    const artifact: SharedArtifact = {
      id,
      orchestrationId: input.orchestrationId,
      producerTaskId: input.producerTaskId,
      kind: input.publication.kind,
      name: input.publication.name.slice(0, 200),
      version: (previous?.version ?? 0) + 1,
      payload: input.publication.payload.slice(0, 20_000),
      createdAt: new Date().toISOString(),
    };
    const records = this.artifacts.get(input.orchestrationId) ?? [];
    records.push(artifact);
    this.artifacts.set(input.orchestrationId, records);
    await input.sink.publishArtifact(artifact);

    const staleTasks = input.tasks.filter(
      (task) =>
        task.id !== input.producerTaskId &&
        (task.requiredArtifactIds.includes(artifact.id) ||
          task.requiredArtifactIds.includes(artifact.name)) &&
        (task.observedArtifactVersions[artifact.id] ?? 0) < artifact.version &&
        !["passed", "failed", "cancelled"].includes(task.status),
    );
    for (const task of staleTasks) {
      task.status = "stale";
      await input.sink.upsertTask(task);
      await input.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: task.id,
        executionId: null,
        type: "dependency.stale",
        actorRole: "control-plane",
        modelId: null,
        summary: `${task.title} observed a stale ${artifact.name} artifact and requires focused refresh.`,
        metadata: { artifactId: artifact.id, newVersion: artifact.version },
      });
    }
    return { artifact, staleTaskIds: staleTasks.map((task) => task.id) };
  }

  async refreshTask(
    task: OrchestrationTask,
    orchestrationId: string,
    sink: OrchestrationSink,
  ): Promise<void> {
    for (const required of task.requiredArtifactIds) {
      const artifact = this.latest(orchestrationId, required);
      if (artifact) task.observedArtifactVersions[artifact.id] = artifact.version;
    }
    task.status = "ready";
    await sink.upsertTask(task);
    await sink.recordEvent({
      orchestrationId,
      taskId: task.id,
      executionId: null,
      type: "dependency.refreshed",
      actorRole: "control-plane",
      modelId: null,
      summary: "Focused context refresh applied current artifact versions.",
      metadata: { artifactCount: Object.keys(task.observedArtifactVersions).length },
    });
  }
}
