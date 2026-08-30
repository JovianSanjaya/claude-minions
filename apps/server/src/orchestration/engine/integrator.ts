import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./application-map.js";
import { normalizeRelative } from "./context-broker.js";
import { diffManifests, hashDirectory, type WorkspaceManifest } from "./worker-workspaces.js";

/**
 * Deterministic-first integration and verified publication.
 *
 * Non-overlapping worker changes are reconciled by comparing manifests, with no
 * model involved. Only genuinely conflicting files are escalated, and the main
 * Agent workspace is written to solely after global verification passes.
 */

export interface TaskChangeSet {
  taskId: string;
  workspaceDirectory: string;
  baseManifest: WorkspaceManifest;
  manifest: WorkspaceManifest;
  changed: string[];
  added: string[];
  removed: string[];
}

export interface MergeOperation {
  path: string;
  taskId: string;
  operation: "write" | "delete";
}

export interface MergeConflict {
  path: string;
  taskIds: string[];
}

export interface MergePlan {
  operations: MergeOperation[];
  conflicts: MergeConflict[];
}

/**
 * Plans a deterministic merge. Two tasks touching the same path only conflict
 * when they produced different content; identical results merge silently.
 */
export function planDeterministicMerge(changeSets: TaskChangeSet[]): MergePlan {
  const byPath = new Map<
    string,
    Array<{ taskId: string; sha: string | null; operation: "write" | "delete" }>
  >();
  for (const changeSet of changeSets) {
    const touched = [
      ...changeSet.changed.map((filePath) => ({ filePath, operation: "write" as const })),
      ...changeSet.added.map((filePath) => ({ filePath, operation: "write" as const })),
      ...changeSet.removed.map((filePath) => ({ filePath, operation: "delete" as const })),
    ];
    for (const { filePath, operation } of touched) {
      const normalized = normalizeRelative(filePath);
      const entries = byPath.get(normalized) ?? [];
      entries.push({
        taskId: changeSet.taskId,
        sha: operation === "delete" ? null : (changeSet.manifest[normalized] ?? null),
        operation,
      });
      byPath.set(normalized, entries);
    }
  }

  const operations: MergeOperation[] = [];
  const conflicts: MergeConflict[] = [];
  for (const [filePath, entries] of [...byPath.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const distinct = new Set(entries.map((entry) => entry.operation + ":" + (entry.sha ?? "")));
    if (entries.length > 1 && distinct.size > 1) {
      conflicts.push({
        path: filePath,
        taskIds: [...new Set(entries.map((entry) => entry.taskId))].sort(),
      });
      continue;
    }
    const winner = entries[0] as { taskId: string; operation: "write" | "delete" };
    operations.push({ path: filePath, taskId: winner.taskId, operation: winner.operation });
  }
  return { operations, conflicts };
}

/** Applies a merge plan into the staging workspace. */
export async function applyMergePlan(
  plan: MergePlan,
  changeSets: TaskChangeSet[],
  stagingDirectory: string,
): Promise<{ applied: string[]; skipped: string[] }> {
  const sources = new Map(changeSets.map((changeSet) => [changeSet.taskId, changeSet]));
  const stagingRoot = path.resolve(stagingDirectory);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const operation of plan.operations) {
    const target = path.resolve(stagingRoot, operation.path);
    if (!isWithin(target, stagingRoot)) {
      skipped.push(operation.path);
      continue;
    }
    if (operation.operation === "delete") {
      await rm(target, { force: true });
      applied.push(operation.path);
      continue;
    }
    const source = sources.get(operation.taskId);
    if (!source) {
      skipped.push(operation.path);
      continue;
    }
    const sourceFile = path.resolve(source.workspaceDirectory, operation.path);
    if (!isWithin(sourceFile, path.resolve(source.workspaceDirectory))) {
      skipped.push(operation.path);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(sourceFile, target);
    applied.push(operation.path);
  }
  return { applied, skipped };
}

/** Writes an integrator-resolved file body into the staging workspace. */
export async function applyResolvedConflict(
  stagingDirectory: string,
  filePath: string,
  content: string,
): Promise<boolean> {
  const stagingRoot = path.resolve(stagingDirectory);
  const target = path.resolve(stagingRoot, normalizeRelative(filePath));
  if (!isWithin(target, stagingRoot)) return false;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, "utf8");
  return true;
}

/** Reads the conflicting file bodies the integrator is allowed to see. */
export async function collectConflictContext(
  conflicts: MergeConflict[],
  changeSets: TaskChangeSet[],
  maxBytes = 32_768,
): Promise<Array<{ path: string; versions: Array<{ taskId: string; content: string }> }>> {
  const results: Array<{
    path: string;
    versions: Array<{ taskId: string; content: string }>;
  }> = [];
  for (const conflict of conflicts) {
    const versions: Array<{ taskId: string; content: string }> = [];
    for (const taskId of conflict.taskIds) {
      const changeSet = changeSets.find((item) => item.taskId === taskId);
      if (!changeSet) continue;
      const absolute = path.resolve(changeSet.workspaceDirectory, conflict.path);
      if (!isWithin(absolute, path.resolve(changeSet.workspaceDirectory))) continue;
      const content = await readFile(absolute, "utf8").catch(() => null);
      if (content === null) continue;
      versions.push({ taskId, content: content.slice(0, maxBytes) });
    }
    results.push({ path: conflict.path, versions });
  }
  return results;
}

export interface WorkspaceDriftReport {
  drifted: boolean;
  conflictingPaths: string[];
}

/**
 * Compares the live main workspace against the base captured before execution.
 * If the user or another process changed a file the integration would publish,
 * the result is a needs-user conflict rather than an overwrite.
 */
export async function detectMainWorkspaceDrift(
  mainWorkspacePath: string,
  baseManifest: WorkspaceManifest,
  publishPaths: string[],
): Promise<WorkspaceDriftReport> {
  const current = await hashDirectory(mainWorkspacePath);
  const diff = diffManifests(baseManifest, current);
  const touchedByUser = new Set([...diff.changed, ...diff.added, ...diff.removed]);
  const conflictingPaths = publishPaths
    .map(normalizeRelative)
    .filter((filePath) => touchedByUser.has(filePath))
    .sort();
  return { drifted: conflictingPaths.length > 0, conflictingPaths };
}

export interface PublishResult {
  published: string[];
  removed: string[];
  rolledBack: boolean;
  error: string | null;
}

/**
 * Publishes staged files to the main workspace with best-effort rollback: the
 * previous body of every touched file is captured first, and any failure
 * restores them so a partial publish is not left behind.
 */
export async function publishToMainWorkspace(input: {
  stagingDirectory: string;
  mainWorkspacePath: string;
  paths: string[];
  removedPaths?: string[];
}): Promise<PublishResult> {
  const stagingRoot = path.resolve(input.stagingDirectory);
  const mainRoot = path.resolve(input.mainWorkspacePath);
  const backups = new Map<string, string | null>();
  const published: string[] = [];
  const removed: string[] = [];

  const restore = async (): Promise<void> => {
    for (const [filePath, previous] of backups) {
      const target = path.resolve(mainRoot, filePath);
      if (previous === null) {
        await rm(target, { force: true }).catch(() => undefined);
      } else {
        await mkdir(path.dirname(target), { recursive: true }).catch(() => undefined);
        await writeFile(target, previous, "utf8").catch(() => undefined);
      }
    }
  };

  try {
    for (const rawPath of [...input.paths, ...(input.removedPaths ?? [])]) {
      const filePath = normalizeRelative(rawPath);
      const target = path.resolve(mainRoot, filePath);
      if (!isWithin(target, mainRoot)) {
        throw new Error("Refusing to publish outside the Agent workspace: " + filePath);
      }
      backups.set(filePath, await readFile(target, "utf8").catch(() => null));
    }
    for (const rawPath of input.paths) {
      const filePath = normalizeRelative(rawPath);
      const source = path.resolve(stagingRoot, filePath);
      const target = path.resolve(mainRoot, filePath);
      if (!isWithin(source, stagingRoot)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      published.push(filePath);
    }
    for (const rawPath of input.removedPaths ?? []) {
      const filePath = normalizeRelative(rawPath);
      const target = path.resolve(mainRoot, filePath);
      await rm(target, { force: true });
      removed.push(filePath);
    }
    return { published, removed, rolledBack: false, error: null };
  } catch (error) {
    await restore();
    return {
      published: [],
      removed: [],
      rolledBack: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
