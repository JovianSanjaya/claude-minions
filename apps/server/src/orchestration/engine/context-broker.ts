import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPacketSummary,
  OrchestrationTask,
} from "../contracts.js";
import type { DetailedApplicationMap } from "./application-map.js";
import { isApplicationMapExcluded } from "./application-map.js";

export interface ContextBrokerOptions {
  maxInitialTokens?: number;
  maxExpansionTokens?: number;
  maxFiles?: number;
  maxCharactersPerFile?: number;
}

const DEFAULT_OPTIONS: Required<ContextBrokerOptions> = {
  maxInitialTokens: 32_000,
  maxExpansionTokens: 24_000,
  maxFiles: 24,
  maxCharactersPerFile: 20_000,
};

function searchTerms(value: string): Set<string> {
  return new Set(
    value.toLowerCase().split(/[^a-z0-9_$.-]+/).filter((term) => term.length >= 3),
  );
}

function compactSource(source: string, maximumCharacters: number): string {
  if (source.length <= maximumCharacters) return source;
  const head = Math.floor(maximumCharacters * 0.7);
  const tail = maximumCharacters - head;
  return `${source.slice(0, head)}\n\n[... middle omitted; read this file in the workspace if needed ...]\n\n${source.slice(-tail)}`;
}

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
    options: ContextBrokerOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private readonly options: Required<ContextBrokerOptions>;

  async createPacket(
    task: OrchestrationTask,
    map: DetailedApplicationMap,
    contractVersion: number,
    artifactVersions: Record<string, number>,
  ): Promise<ContextPacket> {
    const allowed = task.allowedPaths.map((entry) => entry.replaceAll("\\", "/").replace(/\/$/, ""));
    const terms = searchTerms(`${task.title} ${task.objective} ${task.allowedPaths.join(" ")}`);
    const paths = map.entries
      .filter((entry) => allowed.includes(".") || allowed.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)))
      .map((entry) => {
        const searchable = `${entry.path} ${entry.summary} ${entry.imports.join(" ")} ${entry.exports.join(" ")}`.toLowerCase();
        const matches = [...terms].filter((term) => searchable.includes(term)).length;
        const exact = allowed.includes(entry.path) ? 100 : 0;
        const manifest = /(^|\/)(?:package\.json|tsconfig\.json|pyproject\.toml|go\.mod|cargo\.toml)$/i.test(entry.path) ? 20 : 0;
        return { path: entry.path, score: exact + manifest + matches };
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, this.options.maxFiles)
      .map((entry) => entry.path);
    return this.packet(
      task,
      map,
      contractVersion,
      artifactVersions,
      paths,
      this.options.maxInitialTokens,
    );
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
    return this.packet(
      task,
      map,
      contractVersion,
      artifactVersions,
      requestedPaths.slice(0, this.options.maxFiles),
      this.options.maxExpansionTokens,
    );
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
    maximumTokens: number,
  ): Promise<ContextPacket> {
    const root = await realpath(this.workspacePath);
    const source = new Map<string, string>();
    const sourceFiles: ContextPacketSummary["sourceFiles"] = [];
    let includedCharacters = 0;
    const maximumCharacters = maximumTokens * 4;
    for (const requested of [...new Set(requestedPaths)]) {
      if (includedCharacters >= maximumCharacters) break;
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
      const fullContent = await readFile(absolute, "utf8");
      const remaining = maximumCharacters - includedCharacters;
      const content = compactSource(
        fullContent,
        Math.max(1, Math.min(this.options.maxCharactersPerFile, remaining)),
      );
      source.set(normalized, content);
      sourceFiles.push({ path: normalized, sha256: entry.sha256, bytes: entry.bytes });
      includedCharacters += content.length;
    }
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
        estimatedTokens: Math.ceil(includedCharacters / 4),
      },
      applicationSummary: map.summary.summary,
      contractCriterionIds: [...task.acceptanceCriterionIds],
      taskObjective: task.objective,
      source,
    };
  }
}
