import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  BudgetPolicy,
  ContextPacketSummary,
  ExecutionContract,
  OrchestrationTask,
  SharedArtifact,
} from "../contracts.js";
import {
  EXCLUDED_DIRECTORIES,
  isExcludedFileName,
  isWithin,
  renderMapForModel,
  type ApplicationMap,
} from "./application-map.js";

/**
 * Hierarchical context packets and narrow, budgeted progressive disclosure.
 *
 * A worker receives: the compact global map, the relevant contract excerpt,
 * its own objective and dependency versions, the interfaces it must honour,
 * and only the source files its allowed paths (plus one dependency hop) need.
 * The goal is minimum *sufficient* context, not minimum possible context.
 */

export const MAX_CONTEXT_FILES = 24;
export const MAX_CONTEXT_FILE_BYTES = 96 * 1024;
export const MAX_EXPANSION_FILE_BYTES = 96 * 1024;

export interface ContextFile {
  path: string;
  sha256: string;
  bytes: number;
  content: string;
}

export interface ContextPacket {
  summary: ContextPacketSummary;
  /** Fully rendered prompt context. Never persisted to the orchestration store. */
  rendered: string;
  files: ContextFile[];
}

export interface BuildPacketInput {
  task: OrchestrationTask;
  contract: ExecutionContract;
  map: ApplicationMap;
  artifacts: SharedArtifact[];
  workspacePath: string;
  /** Paths granted by earlier approved expansions. */
  expandedPaths?: string[];
}

/** Simple `*` / `**` glob matching over normalized relative paths. */
export function matchesAllowedPath(filePath: string, patterns: string[]): boolean {
  const normalized = normalizeRelative(filePath);
  return patterns.some((pattern) => {
    const cleaned = normalizeRelative(pattern);
    if (!cleaned) return false;
    if (cleaned === normalized) return true;
    if (!cleaned.includes("*")) {
      return normalized === cleaned || normalized.startsWith(cleaned.replace(/\/$/, "") + "/");
    }
    const expression = cleaned
      .split("/")
      .map((segment) =>
        segment === "**"
          ? "(?:.+)"
          : segment
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[^/]*"),
      )
      .join("/")
      .replace(/\(\?:\.\+\)\//g, "(?:.+/)?");
    return new RegExp("^" + expression + "$").test(normalized);
  });
}

export function normalizeRelative(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

export class ContextBroker {
  constructor(private readonly options: { protectedPaths?: string[] } = {}) {}

  /**
   * Selects the minimum-sufficient file set for one task: files inside its
   * allowed paths, one dependency hop away from them, plus explicitly granted
   * expansions. Full source never enters the orchestration database - only
   * paths, hashes, byte counts and a token estimate.
   */
  async buildPacket(input: BuildPacketInput): Promise<ContextPacket> {
    const { task, map, contract, artifacts, workspacePath } = input;
    const expanded = (input.expandedPaths ?? []).map(normalizeRelative);
    const selected = selectTaskFiles(map, task, expanded);

    const files: ContextFile[] = [];
    for (const relativePath of selected) {
      const loaded = await this.loadFile(workspacePath, relativePath);
      if (loaded) files.push(loaded);
      if (files.length >= MAX_CONTEXT_FILES) break;
    }

    const relevantArtifacts = artifacts.filter(
      (artifact) =>
        task.requiredArtifactIds.includes(artifact.name) ||
        task.requiredArtifactIds.includes(artifact.id),
    );
    const artifactVersions: Record<string, number> = {};
    for (const artifact of relevantArtifacts) {
      const current = artifactVersions[artifact.name];
      if (current === undefined || artifact.version > current) {
        artifactVersions[artifact.name] = artifact.version;
      }
    }

    const relevantCriteria = contract.criteria.filter((criterion) =>
      task.acceptanceCriterionIds.includes(criterion.id),
    );

    const rendered = renderPacket({
      task,
      map,
      criteria: relevantCriteria,
      artifacts: relevantArtifacts,
      files,
    });

    const summary: ContextPacketSummary = {
      taskId: task.id,
      applicationMapVersion: map.version,
      contractVersion: contract.version,
      sourceFiles: files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
      })),
      relevantInterfaces: relevantArtifacts.map(
        (artifact) => artifact.name + "@v" + artifact.version,
      ),
      artifactVersions,
      estimatedTokens: estimateTokens(rendered),
    };

    return { summary, rendered, files };
  }

  /**
   * Validates a narrow expansion request. Traversal, symlink escape, protected
   * paths, secret-shaped files and exhausted expansion budgets are refused with
   * a recorded reason.
   */
  async evaluateExpansion(input: {
    workspacePath: string;
    requestedPath: string;
    reason: string;
    priorExpansions: number;
    budget: BudgetPolicy;
  }): Promise<{ allowed: boolean; reason: string; resolvedPath?: string }> {
    const { workspacePath, requestedPath, priorExpansions, budget } = input;
    if (priorExpansions >= budget.maxContextExpansionsPerTask) {
      return {
        allowed: false,
        reason:
          "Context expansion budget exhausted (" +
          priorExpansions +
          "/" +
          budget.maxContextExpansionsPerTask +
          ")",
      };
    }
    if (!input.reason || input.reason.trim().length < 8) {
      return { allowed: false, reason: "Expansion requests must state a concrete reason" };
    }
    const candidate = normalizeRelative(requestedPath);
    if (!candidate) {
      return { allowed: false, reason: "Expansion path was empty" };
    }
    if (path.isAbsolute(requestedPath) || candidate.split("/").includes("..")) {
      return {
        allowed: false,
        reason: "Expansion path must be relative to the workspace and may not traverse upwards",
      };
    }
    const segments = candidate.split("/");
    if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
      return { allowed: false, reason: "Expansion path is inside an excluded directory" };
    }
    const fileName = segments.at(-1) ?? "";
    if (isExcludedFileName(fileName)) {
      return { allowed: false, reason: "Expansion path resolves to a credential-shaped file" };
    }

    const root = await safeRealpath(path.resolve(workspacePath));
    const absolute = path.resolve(root, candidate);
    const resolved = await safeRealpath(absolute);
    for (const protectedPath of this.options.protectedPaths ?? []) {
      const protectedRoot = await safeRealpath(path.resolve(protectedPath));
      if (isWithin(resolved, protectedRoot)) {
        return { allowed: false, reason: "Expansion path is inside protected storage" };
      }
    }
    if (!isWithin(resolved, root)) {
      return {
        allowed: false,
        reason: "Expansion path escapes the worker workspace boundary",
      };
    }
    const stats = await stat(resolved).catch(() => null);
    if (!stats || !stats.isFile()) {
      return { allowed: false, reason: "Expansion path is not a readable file" };
    }
    if (stats.size > MAX_EXPANSION_FILE_BYTES) {
      return { allowed: false, reason: "Expansion target exceeds the context size limit" };
    }
    return { allowed: true, reason: "Narrow expansion granted: " + candidate, resolvedPath: candidate };
  }

  private async loadFile(
    workspacePath: string,
    relativePath: string,
  ): Promise<ContextFile | null> {
    const root = await safeRealpath(path.resolve(workspacePath));
    const absolute = path.resolve(root, relativePath);
    const resolved = await safeRealpath(absolute);
    if (!isWithin(resolved, root)) return null;
    for (const protectedPath of this.options.protectedPaths ?? []) {
      const protectedRoot = await safeRealpath(path.resolve(protectedPath));
      if (isWithin(resolved, protectedRoot)) return null;
    }
    const stats = await stat(resolved).catch(() => null);
    if (!stats || !stats.isFile() || stats.size > MAX_CONTEXT_FILE_BYTES) return null;
    const content = await readFile(resolved, "utf8").catch(() => null);
    if (content === null) return null;
    return {
      path: normalizeRelative(relativePath),
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: stats.size,
      content,
    };
  }
}

/**
 * Deterministic file selection: allowed paths first, then a single dependency
 * hop, then approved expansions. Nothing else is broadcast to the worker.
 */
export function selectTaskFiles(
  map: ApplicationMap,
  task: OrchestrationTask,
  expandedPaths: string[] = [],
): string[] {
  const direct = map.files
    .map((file) => file.path)
    .filter((filePath) => matchesAllowedPath(filePath, task.allowedPaths));
  const selected = new Set(direct);
  for (const filePath of direct) {
    for (const dependency of map.dependencyEdges[filePath] ?? []) {
      if (selected.size >= MAX_CONTEXT_FILES) break;
      selected.add(dependency);
    }
  }
  for (const expandedPath of expandedPaths) {
    selected.add(normalizeRelative(expandedPath));
  }
  return [...selected].sort().slice(0, MAX_CONTEXT_FILES);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderPacket(input: {
  task: OrchestrationTask;
  map: ApplicationMap;
  criteria: ExecutionContract["criteria"];
  artifacts: SharedArtifact[];
  files: ContextFile[];
}): string {
  const sections: string[] = [];
  sections.push("## Global application map (compact)");
  sections.push(renderMapForModel(input.map, 80));
  sections.push("");
  sections.push("## Acceptance criteria for this task");
  sections.push(
    input.criteria.length > 0
      ? input.criteria
          .map(
            (criterion) =>
              "- " +
              criterion.id +
              " [" +
              criterion.kind +
              "/" +
              criterion.verification +
              "] " +
              criterion.description,
          )
          .join("\n")
      : "- (no task-specific criteria)",
  );
  sections.push("");
  sections.push("## Task");
  sections.push("Title: " + input.task.title);
  sections.push("Objective: " + input.task.objective);
  sections.push("Allowed paths: " + input.task.allowedPaths.join(", "));
  sections.push(
    "Dependency artifact versions: " +
      (Object.keys(input.task.observedArtifactVersions).length > 0
        ? JSON.stringify(input.task.observedArtifactVersions)
        : "none"),
  );
  sections.push("");
  sections.push("## Shared interfaces and artifacts");
  sections.push(
    input.artifacts.length > 0
      ? input.artifacts
          .map(
            (artifact) =>
              "### " +
              artifact.name +
              " v" +
              artifact.version +
              " (" +
              artifact.kind +
              ")\n" +
              artifact.payload.slice(0, 4_000),
          )
          .join("\n\n")
      : "(none)",
  );
  sections.push("");
  sections.push("## Source files in scope");
  sections.push(
    input.files.length > 0
      ? input.files
          .map((file) => "### " + file.path + "\n```\n" + file.content + "\n```")
          .join("\n\n")
      : "(no existing files matched the allowed paths - create them)",
  );
  return sections.join("\n");
}

async function safeRealpath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}
