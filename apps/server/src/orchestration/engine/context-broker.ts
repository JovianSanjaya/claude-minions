import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPacketSummary,
  ExecutionContract,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
} from "../contracts.js";
import type { ApplicationMap, ApplicationMapFile } from "./application-map.js";
import { isProtectedRelativePath } from "./application-map.js";

export interface ContextSource extends ApplicationMapFile {
  content: string;
}

export interface ContextPacket {
  summary: ContextPacketSummary;
  applicationSummary: string;
  contractExcerpt: string[];
  taskObjective: string;
  allowedPaths: string[];
  sources: ContextSource[];
}

export type ContextExpansionDecision =
  | { allowed: true; source: ContextSource }
  | { allowed: false; reason: string };

export interface ContextBrokerOptions {
  maxInitialFiles?: number;
  maxInitialBytes?: number;
}

function pathAllowed(relative: string, allowedPaths: string[]): boolean {
  const normalized = relative.replaceAll("\\", "/");
  return allowedPaths.some((allowedValue) => {
    const allowed = allowedValue
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/\*\*?$/, "")
      .replace(/\/$/, "");
    return allowed === "." || normalized === allowed || normalized.startsWith(allowed + "/");
  });
}

export async function resolveSafeWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ root: string; absolute: string; relative: string }> {
  if (path.isAbsolute(requestedPath)) throw new Error("Absolute context paths are forbidden");
  const normalized = requestedPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (isProtectedRelativePath(normalized)) throw new Error("Protected context path denied");
  const root = await realpath(workspaceRoot);
  const candidate = path.resolve(root, normalized);
  if (candidate === root || !candidate.startsWith(root + path.sep)) {
    throw new Error("Context path escapes the Agent workspace");
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new Error("Symbolic-link context paths are forbidden");
  const absolute = await realpath(candidate);
  if (!absolute.startsWith(root + path.sep)) {
    throw new Error("Resolved context path escapes the Agent workspace");
  }
  if (!info.isFile()) throw new Error("Context expansion must target a file");
  return { root, absolute, relative: path.relative(root, absolute).replaceAll(path.sep, "/") };
}

export class ContextBroker {
  private readonly expansionCounts = new Map<string, number>();
  private readonly maxInitialFiles: number;
  private readonly maxInitialBytes: number;

  constructor(options: ContextBrokerOptions = {}) {
    this.maxInitialFiles = options.maxInitialFiles ?? 24;
    this.maxInitialBytes = options.maxInitialBytes ?? 256_000;
  }

  async createPacket(input: {
    map: ApplicationMap;
    task: OrchestrationTask;
    contract: ExecutionContract;
    artifacts: SharedArtifact[];
    sink: OrchestrationSink;
  }): Promise<ContextPacket> {
    const candidates = input.map.files.filter((file) =>
      pathAllowed(file.path, input.task.allowedPaths),
    );
    const interfaceCandidates = input.map.files.filter(
      (file) =>
        /(?:types?|contracts?|schemas?|api)\.[cm]?[jt]sx?$/.test(file.path) &&
        !candidates.some((candidate) => candidate.path === file.path),
    );
    const projectMetadata = input.map.files.filter(
      (file) =>
        /(^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]*lock[^/]*)$/.test(file.path) &&
        !candidates.some((candidate) => candidate.path === file.path) &&
        !interfaceCandidates.some((candidate) => candidate.path === file.path),
    );
    const selected: ApplicationMapFile[] = [];
    let bytes = 0;
    for (const file of [...candidates, ...interfaceCandidates, ...projectMetadata]) {
      if (selected.length >= this.maxInitialFiles) break;
      if (bytes + file.bytes > this.maxInitialBytes && selected.length > 0) continue;
      selected.push(file);
      bytes += file.bytes;
    }
    const sources = await Promise.all(
      selected.map(async (file): Promise<ContextSource> => ({
        ...file,
        content: await readFile(path.join(input.map.rootPath, file.path), "utf8"),
      })),
    );
    const artifactVersions = Object.fromEntries(
      input.artifacts.map((artifact) => [artifact.id, artifact.version]),
    );
    const relevantInterfaces = [
      ...sources
        .filter((source) => /(?:types?|contracts?|schemas?|api)\.[cm]?[jt]sx?$/.test(source.path))
        .map((source) => source.path),
      ...input.artifacts.map((artifact) => `${artifact.name}@v${artifact.version}`),
    ];
    const summary: ContextPacketSummary = {
      taskId: input.task.id,
      applicationMapVersion: input.map.summary.version,
      contractVersion: input.contract.version,
      sourceFiles: sources.map(({ path: filePath, sha256, bytes: fileBytes }) => ({
        path: filePath,
        sha256,
        bytes: fileBytes,
      })),
      relevantInterfaces,
      artifactVersions,
      estimatedTokens: Math.ceil(bytes / 4),
    };
    await input.sink.recordContextPacket(summary);
    return {
      summary,
      applicationSummary: `${input.map.summary.summary} ${input.map.moduleSummaries.join("; ")}`.slice(0, 8_000),
      contractExcerpt: input.contract.criteria
        .filter((criterion) => input.task.acceptanceCriterionIds.includes(criterion.id))
        .map((criterion) => `${criterion.id} [${criterion.kind}]: ${criterion.description}`),
      taskObjective: input.task.objective,
      allowedPaths: [...input.task.allowedPaths],
      sources,
    };
  }

  async requestExpansion(input: {
    orchestrationId: string;
    task: OrchestrationTask;
    map: ApplicationMap;
    requestedPath: string;
    reason: string;
    maxExpansions: number;
    sink: OrchestrationSink;
  }): Promise<ContextExpansionDecision> {
    const used = this.expansionCounts.get(input.task.id) ?? 0;
    let decision: ContextExpansionDecision;
    if (used >= input.maxExpansions) {
      decision = { allowed: false, reason: "Task context-expansion budget exhausted" };
    } else {
      try {
        const resolved = await resolveSafeWorkspaceFile(
          input.map.rootPath,
          input.requestedPath,
        );
        const mapped = input.map.files.find((file) => file.path === resolved.relative);
        if (!mapped) throw new Error("Requested file is excluded from the application map");
        const content = await readFile(resolved.absolute, "utf8");
        this.expansionCounts.set(input.task.id, used + 1);
        decision = { allowed: true, source: { ...mapped, content } };
      } catch (error) {
        decision = {
          allowed: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await input.sink.recordEvent({
      orchestrationId: input.orchestrationId,
      taskId: input.task.id,
      executionId: null,
      type: decision.allowed ? "context.expanded" : "context.expansion-denied",
      actorRole: "control-plane",
      modelId: null,
      summary: decision.allowed
        ? `Granted narrow context expansion for ${decision.source.path}`
        : decision.reason,
      metadata: {
        requestedPath: input.requestedPath.slice(0, 240),
        reason: input.reason.slice(0, 500),
        expansionsUsed: decision.allowed ? used + 1 : used,
      },
    });
    return decision;
  }
}
