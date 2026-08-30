import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface ManifestEntry {
  path: string;
  sha256: string;
}
export type WorkspaceManifest = ManifestEntry[];

const IGNORED_DIR_NAMES = new Set([".git", "node_modules"]);

async function walkForManifest(root: string, current: string, entries: ManifestEntry[]): Promise<void> {
  let items;
  try {
    items = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (item.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(item.name)) continue;
      await walkForManifest(root, path.join(current, item.name), entries);
      continue;
    }
    if (!item.isFile()) continue;
    const full = path.join(current, item.name);
    try {
      const content = await readFile(full);
      entries.push({
        path: path.relative(root, full),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } catch {
      // unreadable file (permissions, race with a concurrent delete): skip rather than fail the whole scan
    }
  }
}

/** A content-addressed manifest of every file under `root` (excluding .git/node_modules). */
export async function buildManifest(root: string): Promise<WorkspaceManifest> {
  const entries: ManifestEntry[] = [];
  await walkForManifest(root, root, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

export function manifestsDiffer(a: WorkspaceManifest, b: WorkspaceManifest): boolean {
  if (a.length !== b.length) return true;
  const byPath = new Map(a.map((entry) => [entry.path, entry.sha256]));
  for (const entry of b) {
    if (byPath.get(entry.path) !== entry.sha256) return true;
  }
  return false;
}

export interface TaskWorkspace {
  taskId: string;
  path: string;
  baseManifest: WorkspaceManifest;
}

function isIgnoredForCopy(sourcePath: string): boolean {
  const segments = sourcePath.split(path.sep);
  return segments.includes(".git") || segments.includes("node_modules");
}

/**
 * Creates an isolated, task-specific copy of the Agent workspace under a
 * trusted orchestration-scoped scratch root, so concurrent workers never
 * mutate the main workspace or each other's files. Returns the workspace
 * together with a base manifest captured immediately after the copy, used
 * later to compute exactly which files a worker changed.
 */
export async function createTaskWorkspace(
  scratchRoot: string,
  orchestrationId: string,
  taskId: string,
  sourceWorkspacePath: string,
): Promise<TaskWorkspace> {
  await mkdir(scratchRoot, { recursive: true });
  const safeOrchestration = orchestrationId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const safeTask = taskId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const dir = await mkdtemp(path.join(scratchRoot, `${safeOrchestration}-${safeTask}-`));
  await cp(sourceWorkspacePath, dir, {
    recursive: true,
    filter: (source) => !isIgnoredForCopy(source),
  });
  const baseManifest = await buildManifest(dir);
  return { taskId, path: dir, baseManifest };
}

/** Files changed (including deletions) relative to the workspace's base manifest. */
export async function diffWorkspace(workspace: TaskWorkspace): Promise<string[]> {
  const current = await buildManifest(workspace.path);
  const baseByPath = new Map(workspace.baseManifest.map((entry) => [entry.path, entry.sha256]));
  const currentByPath = new Map(current.map((entry) => [entry.path, entry.sha256]));
  const changed = new Set<string>();
  for (const [filePath, hash] of currentByPath) {
    if (baseByPath.get(filePath) !== hash) changed.add(filePath);
  }
  for (const filePath of baseByPath.keys()) {
    if (!currentByPath.has(filePath)) changed.add(filePath);
  }
  return [...changed].sort();
}

export function isPathWithinAllowed(relativePath: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return true;
  const normalized = relativePath.split(path.sep).join("/");
  return allowedPaths.some((allowed) => {
    const normalizedAllowed = allowed.replace(/\/+$/, "");
    return normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + "/");
  });
}

/**
 * Deletes a task workspace. Refuses (throws, does not silently no-op) if
 * the resolved path is not actually inside the trusted scratch root — the
 * spec's "reject cleanup and retain for manual review" rule for an unsafe
 * cleanup target.
 */
export async function cleanupTaskWorkspace(workspace: TaskWorkspace, scratchRoot: string): Promise<void> {
  const resolved = path.resolve(workspace.path);
  const resolvedRoot = path.resolve(scratchRoot);
  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `Refusing to clean up "${resolved}": it is not inside the trusted scratch root "${resolvedRoot}"`,
    );
  }
  await rm(resolved, { recursive: true, force: true });
}
