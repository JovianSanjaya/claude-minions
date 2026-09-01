import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPacketSummary,
  OrchestrationTask,
} from "../contracts.js";
import type { DetailedApplicationMap } from "./application-map.js";
import { isApplicationMapExcluded } from "./application-map.js";

export interface ContextPacket {
  summary: ContextPacketSummary;
  applicationSummary: string;
  contractCriterionIds: string[];
  taskObjective: string;
  source: Map<string, string>;
}

export class ContextAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextAccessError";
  }
}

export class ContextBroker {
  private readonly expansions = new Map<string, number>();

  constructor(
    private readonly workspacePath: string,
    private readonly maxExpansionsPerTask: number,
  ) {}

  async createPacket(
    task: OrchestrationTask,
    map: DetailedApplicationMap,
    contractVersion: number,
    artifactVersions: Record<string, number>,
  ): Promise<ContextPacket> {
    const allowed = task.allowedPaths.map((entry) => entry.replaceAll("\\", "/").replace(/\/$/, ""));
    const paths = map.entries
      .filter((entry) => allowed.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)))
      .map((entry) => entry.path);
    return this.packet(task, map, contractVersion, artifactVersions, paths);
  }

  async expand(
    task: OrchestrationTask,
    map: DetailedApplicationMap,
    contractVersion: number,
    artifactVersions: Record<string, number>,
    requestedPaths: string[],
    reason: string,
  ): Promise<ContextPacket> {
    if (!reason.trim()) throw new ContextAccessError("Context expansion requires a reason");
    const used = this.expansions.get(task.id) ?? 0;
    if (used >= this.maxExpansionsPerTask) {
      throw new ContextAccessError("Context expansion budget exhausted");
    }
    if (!requestedPaths.length || requestedPaths.length > 20) {
      throw new ContextAccessError("Context expansion must request 1 to 20 paths");
    }
    this.expansions.set(task.id, used + 1);
    return this.packet(task, map, contractVersion, artifactVersions, requestedPaths);
  }

  expansionCount(taskId: string): number {
    return this.expansions.get(taskId) ?? 0;
  }

  private async packet(
    task: OrchestrationTask,
    map: DetailedApplicationMap,
    contractVersion: number,
    artifactVersions: Record<string, number>,
    requestedPaths: string[],
  ): Promise<ContextPacket> {
    const root = await realpath(this.workspacePath);
    const source = new Map<string, string>();
    const sourceFiles: ContextPacketSummary["sourceFiles"] = [];
    for (const requested of [...new Set(requestedPaths)].sort()) {
      const normalized = requested.replaceAll("\\", "/");
      if (
        path.isAbsolute(normalized) ||
        normalized.split("/").includes("..") ||
        isApplicationMapExcluded(normalized)
      ) {
        throw new ContextAccessError(`Protected or invalid context path: ${normalized}`);
      }
      const entry = map.entries.find((candidate) => candidate.path === normalized);
      if (!entry) throw new ContextAccessError(`Context path is not in application map: ${normalized}`);
      const absolute = await realpath(path.join(root, normalized));
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        throw new ContextAccessError(`Context path escapes workspace: ${normalized}`);
      }
      if ((await lstat(path.join(root, normalized))).isSymbolicLink()) {
        throw new ContextAccessError(`Context path may not be a symlink: ${normalized}`);
      }
      const content = await readFile(absolute, "utf8");
      source.set(normalized, content);
      sourceFiles.push({ path: normalized, sha256: entry.sha256, bytes: entry.bytes });
    }
    const bytes = sourceFiles.reduce((total, file) => total + file.bytes, 0);
    return {
      summary: {
        taskId: task.id,
        applicationMapVersion: map.summary.version,
        contractVersion,
        sourceFiles,
        relevantInterfaces: map.entries
          .filter((entry) => source.has(entry.path))
          .flatMap((entry) => entry.exports.map((symbol) => `${entry.path}#${symbol}`))
          .slice(0, 100),
        artifactVersions: { ...artifactVersions },
        estimatedTokens: Math.ceil(bytes / 4),
      },
      applicationSummary: map.summary.summary,
      contractCriterionIds: [...task.acceptanceCriterionIds],
      taskObjective: task.objective,
      source,
    };
  }
}
