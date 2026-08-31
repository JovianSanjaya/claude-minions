import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isApplicationMapExcluded, isProtectedEnvironmentPath } from "./application-map.js";

export interface WorkspaceManifest {
  rootHash: string;
  files: Record<string, string>;
}

export interface WorkerWorkspace {
  orchestrationId: string;
  taskId: string;
  path: string;
  base: WorkspaceManifest;
  allowedPaths: string[];
}

export interface WorkspaceChanges {
  changedFiles: string[];
  deletedFiles: string[];
  hashes: Record<string, string>;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  if (!safe || safe === "." || safe === "..") throw new Error("Unsafe workspace identifier");
  return safe;
}

function within(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

export async function copyWorkspaceTree(source: string, destination: string, relative = ""): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (isApplicationMapExcluded(childRelative)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stats = await lstat(from);
    if (stats.isSymbolicLink()) throw new Error(`Workspace snapshot rejects symlink: ${childRelative}`);
    if (stats.isDirectory()) await copyWorkspaceTree(from, to, childRelative);
    else if (stats.isFile()) await copyFile(from, to);
  }
}

export async function workspaceManifest(rootPath: string): Promise<WorkspaceManifest> {
  const root = await realpath(rootPath);
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (isApplicationMapExcluded(relative)) continue;
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new Error(`Manifest rejects symlink: ${relative}`);
      if (stats.isDirectory()) await walk(absolute);
      else if (stats.isFile()) {
        files[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
      }
    }
  };
  await walk(root);
  const rootHash = createHash("sha256")
    .update(Object.entries(files).map(([name, hash]) => `${name}:${hash}`).join("\n"))
    .digest("hex");
  return { rootHash, files };
}

export function diffManifest(base: WorkspaceManifest, current: WorkspaceManifest): WorkspaceChanges {
  const changedFiles = Object.keys(current.files).filter(
    (file) => base.files[file] !== current.files[file],
  );
  const deletedFiles = Object.keys(base.files).filter((file) => !(file in current.files));
  return {
    changedFiles: changedFiles.sort(),
    deletedFiles: deletedFiles.sort(),
    hashes: Object.fromEntries(changedFiles.map((file) => [file, current.files[file]!])),
  };
}

export function scopeViolations(changes: WorkspaceChanges, allowedPaths: string[]): string[] {
  const allowed = allowedPaths.map((entry) => entry.replaceAll("\\", "/").replace(/\/$/, ""));
  return [...changes.changedFiles, ...changes.deletedFiles].filter(
    (file) =>
      isProtectedEnvironmentPath(file) ||
      (!allowed.includes(".") &&
        !allowed.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))),
  );
}

export function scopeViolationSummary(violations: string[], maximumPaths = 12): string {
  const visible = violations.slice(0, maximumPaths);
  const omitted = Math.max(0, violations.length - visible.length);
  return `${visible.join(", ")}${omitted ? ` (+${omitted} more)` : ""}`;
}

export class WorkerWorkspaceManager {
  constructor(
    private readonly tempRoot: string,
    private readonly archiveRoot: string,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
  }

  async create(
    sourceWorkspace: string,
    orchestrationId: string,
    taskId: string,
    allowedPaths: string[],
  ): Promise<WorkerWorkspace> {
    await this.initialize();
    const source = await realpath(sourceWorkspace);
    const temp = await realpath(this.tempRoot);
    if (source === temp || source.startsWith(`${temp}${path.sep}`) || temp.startsWith(`${source}${path.sep}`)) {
      throw new Error("Worker temp root must be separate from the Agent workspace");
    }
    const orchestrationRoot = path.join(temp, safeSegment(orchestrationId));
    const destination = path.join(orchestrationRoot, safeSegment(taskId));
    if (!within(temp, destination)) throw new Error("Unsafe worker workspace target");
    await mkdir(orchestrationRoot, { recursive: true, mode: 0o700 });
    await mkdir(destination, { recursive: false, mode: 0o700 });
    await copyWorkspaceTree(source, destination);
    return {
      orchestrationId,
      taskId,
      path: destination,
      base: await workspaceManifest(destination),
      allowedPaths: [...allowedPaths],
    };
  }

  async changes(workspace: WorkerWorkspace): Promise<WorkspaceChanges> {
    return diffManifest(workspace.base, await workspaceManifest(workspace.path));
  }

  async cleanup(
    workspace: WorkerWorkspace,
    policy: "clean" | "archive" | "retain",
  ): Promise<{ status: "cleaned" | "archived" | "retained"; path: string | null }> {
    const temp = await realpath(this.tempRoot);
    const target = await realpath(workspace.path);
    if (!within(temp, target)) throw new Error("Refusing unsafe worker cleanup target");
    if (policy === "retain") return { status: "retained", path: target };
    if (policy === "archive") {
      const archive = await realpath(this.archiveRoot);
      const destination = path.join(
        archive,
        `${safeSegment(workspace.orchestrationId)}-${safeSegment(workspace.taskId)}-${Date.now()}`,
      );
      if (!within(archive, destination)) throw new Error("Refusing unsafe archive target");
      await rename(target, destination);
      return { status: "archived", path: destination };
    }
    await rm(target, { recursive: true, force: false });
    return { status: "cleaned", path: null };
  }

  async cleanupOrchestration(
    orchestrationId: string,
    policy: "clean" | "archive" | "retain",
  ): Promise<void> {
    await this.initialize();
    const temp = await realpath(this.tempRoot);
    const target = path.join(temp, safeSegment(orchestrationId));
    if (!within(temp, target)) throw new Error("Refusing unsafe orchestration cleanup target");
    const resolved = await realpath(target).catch(() => null);
    if (!resolved) return;
    if (policy === "retain") return;
    if (policy === "archive") {
      const archive = await realpath(this.archiveRoot);
      const destination = path.join(
        archive,
        `${safeSegment(orchestrationId)}-reconciled-${Date.now()}`,
      );
      if (!within(archive, destination)) throw new Error("Refusing unsafe orchestration archive target");
      await rename(resolved, destination);
      return;
    }
    await rm(resolved, { recursive: true, force: false });
  }
}
