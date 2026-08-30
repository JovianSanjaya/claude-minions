import { randomUUID } from "node:crypto";
import type {
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
} from "../contracts.js";

/**
 * Versioned shared artifacts and dependency-drift detection.
 *
 * Workers coordinate through typed artifacts - API contracts, interface
 * signatures, schemas, decisions, manifests, test results - never through one
 * another's transcripts. When an artifact version changes, only the tasks that
 * actually depend on it are marked stale and refreshed.
 */

export const MAX_ARTIFACT_PAYLOAD_CHARS = 8_000;

export interface PublishArtifactInput {
  orchestrationId: string;
  producerTaskId: string;
  kind: SharedArtifact["kind"];
  name: string;
  payload: string;
}

export interface DriftReport {
  /** Tasks that depend on a bumped artifact and observed an older version. */
  staleTaskIds: string[];
  /** Tasks that do not depend on the changed artifact. */
  unaffectedTaskIds: string[];
  artifactName: string;
  fromVersion: number | null;
  toVersion: number;
}

export class ArtifactRegistry {
  private readonly artifacts: SharedArtifact[] = [];

  constructor(
    private readonly options: {
      sink: OrchestrationSink;
      clock?: (() => Date) | undefined;
      idFactory?: (() => string) | undefined;
    },
  ) {}

  all(): SharedArtifact[] {
    return this.artifacts.map((artifact) => ({ ...artifact }));
  }

  names(): string[] {
    return [...new Set(this.artifacts.map((artifact) => artifact.name))].sort();
  }

  latest(name: string): SharedArtifact | null {
    const matches = this.artifacts.filter((artifact) => artifact.name === name);
    if (matches.length === 0) return null;
    return matches.reduce((best, candidate) =>
      candidate.version > best.version ? candidate : best,
    );
  }

  latestVersions(): Record<string, number> {
    const versions: Record<string, number> = {};
    for (const artifact of this.artifacts) {
      const current = versions[artifact.name];
      if (current === undefined || artifact.version > current) {
        versions[artifact.name] = artifact.version;
      }
    }
    return versions;
  }

  /** Publishes the next version of an artifact and persists it through the sink. */
  async publish(input: PublishArtifactInput): Promise<SharedArtifact> {
    const previous = this.latest(input.name);
    const artifact: SharedArtifact = {
      id: (this.options.idFactory ?? randomUUID)(),
      orchestrationId: input.orchestrationId,
      producerTaskId: input.producerTaskId,
      kind: input.kind,
      name: input.name,
      version: (previous?.version ?? 0) + 1,
      payload: input.payload.slice(0, MAX_ARTIFACT_PAYLOAD_CHARS),
      createdAt: (this.options.clock?.() ?? new Date()).toISOString(),
    };
    this.artifacts.push(artifact);
    await this.options.sink.publishArtifact(artifact);
    await this.options.sink.recordEvent({
      orchestrationId: input.orchestrationId,
      taskId: input.producerTaskId,
      executionId: null,
      type: "artifact.published",
      actorRole: "worker",
      modelId: null,
      summary:
        "Published " + artifact.name + " v" + artifact.version + " (" + artifact.kind + ")",
      metadata: {
        artifact: artifact.name,
        version: artifact.version,
        kind: artifact.kind,
        previousVersion: previous?.version ?? null,
      },
    });
    return artifact;
  }

  /**
   * Identifies tasks whose observed artifact version is behind the published
   * version. Only tasks that actually require the artifact are affected.
   */
  detectDrift(artifact: SharedArtifact, tasks: OrchestrationTask[]): DriftReport {
    const staleTaskIds: string[] = [];
    const unaffectedTaskIds: string[] = [];
    for (const task of tasks) {
      if (task.id === artifact.producerTaskId) {
        unaffectedTaskIds.push(task.id);
        continue;
      }
      const requires =
        task.requiredArtifactIds.includes(artifact.name) ||
        task.requiredArtifactIds.includes(artifact.id);
      const observed = task.observedArtifactVersions[artifact.name];
      if (requires && (observed === undefined || observed < artifact.version)) {
        staleTaskIds.push(task.id);
      } else {
        unaffectedTaskIds.push(task.id);
      }
    }
    const previousVersions = this.artifacts
      .filter((item) => item.name === artifact.name && item.version < artifact.version)
      .map((item) => item.version);
    return {
      staleTaskIds,
      unaffectedTaskIds,
      artifactName: artifact.name,
      fromVersion: previousVersions.length > 0 ? Math.max(...previousVersions) : null,
      toVersion: artifact.version,
    };
  }

  /** Records the drift decision so a stale refresh is visible in the timeline. */
  async recordDrift(orchestrationId: string, report: DriftReport): Promise<void> {
    await this.options.sink.recordEvent({
      orchestrationId,
      taskId: null,
      executionId: null,
      type: "artifact.dependency-drift",
      actorRole: "control-plane",
      modelId: null,
      summary:
        report.artifactName +
        " moved to v" +
        report.toVersion +
        "; " +
        report.staleTaskIds.length +
        " dependent task(s) marked stale, " +
        report.unaffectedTaskIds.length +
        " unaffected",
      metadata: {
        artifact: report.artifactName,
        fromVersion: report.fromVersion,
        toVersion: report.toVersion,
        staleTasks: report.staleTaskIds.join(",") || null,
      },
    });
  }
}
