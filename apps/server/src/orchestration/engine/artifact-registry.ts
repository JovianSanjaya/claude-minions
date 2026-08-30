import { randomUUID } from "node:crypto";
import type { OrchestrationSink, SharedArtifact } from "../contracts.js";

export interface ArtifactRegistry {
  latestVersion(name: string): number;
  publish(
    kind: SharedArtifact["kind"],
    name: string,
    payload: string,
    producerTaskId: string,
  ): Promise<SharedArtifact>;
}

/**
 * Versions shared artifacts (API contracts, interfaces, schemas, decisions,
 * manifests, test results) by name, per orchestration. Workers coordinate
 * through these — typed and versioned — rather than through each other's
 * transcripts.
 */
export function createArtifactRegistry(orchestrationId: string, sink: OrchestrationSink): ArtifactRegistry {
  const versions = new Map<string, number>();
  return {
    latestVersion: (name) => versions.get(name) ?? 0,
    async publish(kind, name, payload, producerTaskId) {
      const version = (versions.get(name) ?? 0) + 1;
      versions.set(name, version);
      const artifact: SharedArtifact = {
        id: randomUUID(),
        orchestrationId,
        producerTaskId,
        kind,
        name,
        version,
        payload,
        createdAt: new Date().toISOString(),
      };
      await sink.publishArtifact(artifact);
      return artifact;
    },
  };
}

/**
 * Identifies which tasks observed a stale artifact version. By convention
 * in this engine, `OrchestrationTask.requiredArtifactIds` holds artifact
 * *names* (not the per-version `SharedArtifact.id`, which changes on every
 * publish) — Appendix A does not mandate which convention to use, and names
 * are what a dependency-drift check actually needs to compare against a
 * "latest version by name" map.
 */
export function detectStaleTasks(
  tasks: Array<{ id: string; observedArtifactVersions: Record<string, number>; requiredArtifactIds: string[] }>,
  latestVersionsByName: Record<string, number>,
): string[] {
  const stale: string[] = [];
  for (const task of tasks) {
    for (const name of task.requiredArtifactIds) {
      const latest = latestVersionsByName[name] ?? 0;
      const observed = task.observedArtifactVersions[name] ?? 0;
      if (latest > observed) {
        stale.push(task.id);
        break;
      }
    }
  }
  return stale;
}
