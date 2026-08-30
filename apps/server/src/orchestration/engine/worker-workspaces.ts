import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  EXCLUDED_DIRECTORIES,
  isExcludedFileName,
  isWithin,
} from "./application-map.js";
import { matchesAllowedPath, normalizeRelative } from "./context-broker.js";

/**
 * Isolated worker workspaces.
 *
 * Every task edits its own snapshot under a trusted, orchestration-specific
 * temp root. Workers never concurrently mutate the main Agent workspace or one
 * shared scratch directory, and cleanup only ever targets a resolved,
 * task-specific path inside that root.
 */

export type WorkspaceManifest = Record<string, string>;

export interface WorkerWorkspace {
  orchestrationId: string;
  taskId: string;
  executionId: string;
  directory: string;
  baseManifest: WorkspaceManifest;
  baseHash: string;
  allowedPaths: string[];
}

export interface ChangedFileReport {
  changed: string[];
  added: string[];
  removed: string[];
  manifest: WorkspaceManifest;
  /** Changed paths outside the task's allowed paths. */
  scopeViolations: string[];
}

export type CleanupPolicy = "cleanup" | "archive" | "retain";

export interface CleanupResult {
  policy: CleanupPolicy;
  result: "cleaned" | "archived" | "retained" | "refused";
  path: string;
  reason: string | null;
}

/** Minimum path depth below the temp root before deletion is even considered. */
const MIN_SAFE_DEPTH = 2;

export async function hashDirectory(directory: string): Promise<WorkspaceManifest> {
  const root = await safeRealpath(path.resolve(directory));
  const manifest: WorkspaceManifest = {};
  const walk = async (absolute: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(absolute, entry.name), joinRelative(relative, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedFileName(entry.name)) continue;
      const absoluteFile = path.join(absolute, entry.name);
      const resolved = await safeRealpath(absoluteFile);
      if (!isWithin(resolved, root)) continue;
      const content = await readFile(absoluteFile).catch(() => null);
      if (content === null) continue;
      manifest[joinRelative(relative, entry.name)] = createHash("sha256")
        .update(content)
        .digest("hex");
    }
  };
  await walk(root, "");
  return manifest;
}

export function manifestHash(manifest: WorkspaceManifest): string {
  const hash = createHash("sha256");
  for (const key of Object.keys(manifest).sort()) {
    hash.update(key);
    hash.update(" ");
    hash.update(manifest[key] as string);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function diffManifests(
  base: WorkspaceManifest,
  next: WorkspaceManifest,
): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [filePath, sha] of Object.entries(next)) {
    if (!(filePath in base)) added.push(filePath);
    else if (base[filePath] !== sha) changed.push(filePath);
  }
  for (const filePath of Object.keys(base)) {
    if (!(filePath in next)) removed.push(filePath);
  }
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

export function detectScopeViolations(
  touchedPaths: string[],
  allowedPaths: string[],
): string[] {
  if (allowedPaths.length === 0) return [];
  return touchedPaths
    .filter((filePath) => !matchesAllowedPath(filePath, allowedPaths))
    .sort();
}

export class WorkerWorkspaceManager {
  constructor(
    private readonly tempRoot: string,
    private readonly archiveRoot: string,
  ) {}

  orchestrationRoot(orchestrationId: string): string {
    return path.join(path.resolve(this.tempRoot), sanitizeSegment(orchestrationId));
  }

  /** Creates one task-specific snapshot of the source workspace. */
  async createTaskWorkspace(input: {
    orchestrationId: string;
    taskId: string;
    executionId: string;
    sourcePath: string;
    allowedPaths: string[];
  }): Promise<WorkerWorkspace> {
    const directory = path.join(
      this.orchestrationRoot(input.orchestrationId),
      sanitizeSegment(input.taskId) + "-" + sanitizeSegment(input.executionId),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyWorkspace(input.sourcePath, directory);
    const baseManifest = await hashDirectory(directory);
    return {
      orchestrationId: input.orchestrationId,
      taskId: input.taskId,
      executionId: input.executionId,
      directory,
      baseManifest,
      baseHash: manifestHash(baseManifest),
      allowedPaths: input.allowedPaths,
    };
  }

  /** Creates the integration staging workspace for an orchestration. */
  async createStagingWorkspace(input: {
    orchestrationId: string;
    sourcePath: string;
    label?: string;
  }): Promise<{ directory: string; baseManifest: WorkspaceManifest; baseHash: string }> {
    const directory = path.join(
      this.orchestrationRoot(input.orchestrationId),
      sanitizeSegment(input.label ?? "staging"),
    );
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyWorkspace(input.sourcePath, directory);
    const baseManifest = await hashDirectory(directory);
    return { directory, baseManifest, baseHash: manifestHash(baseManifest) };
  }

  async inspectChanges(workspace: WorkerWorkspace): Promise<ChangedFileReport> {
    const manifest = await hashDirectory(workspace.directory);
    const diff = diffManifests(workspace.baseManifest, manifest);
    const touched = [...diff.changed, ...diff.added, ...diff.removed];
    return {
      ...diff,
      manifest,
      scopeViolations: detectScopeViolations(touched, workspace.allowedPaths),
    };
  }

  /**
   * Cleans, archives, or retains a task workspace. Cleanup is refused unless
   * the resolved target sits safely below the orchestration temp root, so a
   * misconfigured value can never delete `/`, a home directory, or a workspace.
   */
  async cleanup(directory: string, policy: CleanupPolicy): Promise<CleanupResult> {
    const resolved = await safeRealpath(path.resolve(directory));
    const root = await safeRealpath(path.resolve(this.tempRoot));
    const relative = path.relative(root, resolved);
    const unsafe =
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).filter(Boolean).length < MIN_SAFE_DEPTH;
    if (unsafe) {
      return {
        policy,
        result: "refused",
        path: resolved,
        reason:
          "Cleanup target is not a task-specific directory inside the orchestration temp root; retained for manual review",
      };
    }
    if (policy === "retain") {
      return { policy, result: "retained", path: resolved, reason: null };
    }
    if (policy === "archive") {
      const destination = path.join(
        path.resolve(this.archiveRoot),
        relative.split(path.sep).join("-") + "-" + Date.now().toString(36),
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await rename(resolved, destination);
        return { policy, result: "archived", path: destination, reason: null };
      } catch {
        await cp(resolved, destination, { recursive: true, force: true }).catch(
          () => undefined,
        );
        await rm(resolved, { recursive: true, force: true });
        return { policy, result: "archived", path: destination, reason: null };
      }
    }
    await rm(resolved, { recursive: true, force: true });
    return { policy, result: "cleaned", path: resolved, reason: null };
  }
}

/** Copies a workspace tree, skipping excluded directories and secret files. */
export async function copyWorkspace(source: string, destination: string): Promise<void> {
  const sourceRoot = await safeRealpath(path.resolve(source));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const walk = async (absolute: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRelative = joinRelative(relative, entry.name);
      const childSource = path.join(absolute, entry.name);
      const childDestination = path.join(destination, childRelative);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const resolved = await safeRealpath(childSource);
        if (!isWithin(resolved, sourceRoot)) continue;
        await mkdir(childDestination, { recursive: true, mode: 0o700 });
        await walk(childSource, childRelative);
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks and special files are never copied into a worker snapshot.
        continue;
      }
      if (isExcludedFileName(entry.name)) continue;
      const stats = await lstat(childSource).catch(() => null);
      if (!stats || !stats.isFile()) continue;
      await mkdir(path.dirname(childDestination), { recursive: true, mode: 0o700 });
      await cp(childSource, childDestination, { force: true });
    }
  };
  await walk(sourceRoot, "");
}

export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
  return cleaned.replace(/^[.-]+/, "") || "unnamed";
}

function joinRelative(relative: string, name: string): string {
  return relative ? relative + "/" + name : name;
}

export function normalizeManifestPath(candidate: string): string {
  return normalizeRelative(candidate);
}

async function safeRealpath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}
