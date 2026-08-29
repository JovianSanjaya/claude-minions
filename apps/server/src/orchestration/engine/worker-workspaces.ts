import { copyFile, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OrchestrationTask } from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";
import { ApplicationMapBuilder, isProtectedRelativePath } from "./application-map.js";

export interface WorkspaceManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface WorkerWorkspace {
  orchestrationId: string;
  taskId: string;
  executionRoot: string;
  workspacePath: string;
  baseWorkspacePath: string;
  baseRepositoryHash: string;
  baseManifest: Map<string, WorkspaceManifestEntry>;
  materializedPaths: Set<string>;
  allowedPaths: string[];
}

export interface ChangedFileManifest {
  files: Array<WorkspaceManifestEntry & { change: "added" | "modified" | "deleted" }>;
  scopeViolations: string[];
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
  if (!safe || safe === "." || safe === "..") throw new Error("Unsafe workspace identifier");
  return safe;
}

function isAllowed(relativePath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((raw) => {
    const allowed = raw
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/\*\*?$/, "")
      .replace(/\/$/, "");
    return allowed === "." || relativePath === allowed || relativePath.startsWith(allowed + "/");
  });
}

async function copyMapFiles(
  map: ApplicationMap,
  destination: string,
  includedPaths: Set<string>,
): Promise<void> {
  for (const file of map.files.filter((candidate) => includedPaths.has(candidate.path))) {
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(map.rootPath, file.path), target);
  }
}

export class WorkerWorkspaceManager {
  constructor(
    private readonly tempRoot: string,
    private readonly archiveRoot: string,
  ) {}

  async initialize(): Promise<void> {
    const temp = path.resolve(this.tempRoot);
    const archive = path.resolve(this.archiveRoot);
    if (temp === path.parse(temp).root || archive === path.parse(archive).root) {
      throw new Error("Orchestration workspace roots may not be filesystem roots");
    }
    await mkdir(temp, { recursive: true, mode: 0o700 });
    await mkdir(archive, { recursive: true, mode: 0o700 });
  }

  async create(
    orchestrationId: string,
    task: OrchestrationTask,
    map: ApplicationMap,
    includedPaths: string[] = map.files.map((file) => file.path),
  ): Promise<WorkerWorkspace> {
    await this.initialize();
    const executionRoot = path.join(
      path.resolve(this.tempRoot),
      safeSegment(orchestrationId),
      safeSegment(task.id),
    );
    const workspacePath = path.join(executionRoot, "workspace");
    await rm(executionRoot, { recursive: true, force: true });
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    const materializedPaths = new Set(includedPaths);
    await copyMapFiles(map, workspacePath, materializedPaths);
    return {
      orchestrationId,
      taskId: task.id,
      executionRoot,
      workspacePath,
      baseWorkspacePath: map.rootPath,
      baseRepositoryHash: map.summary.repositoryHash,
      baseManifest: new Map(
        map.files.map((file) => [
          file.path,
          { path: file.path, sha256: file.sha256, bytes: file.bytes },
        ]),
      ),
      materializedPaths,
      allowedPaths: [...task.allowedPaths],
    };
  }

  async inspect(handle: WorkerWorkspace): Promise<ChangedFileManifest> {
    const current = await new ApplicationMapBuilder().build(
      handle.orchestrationId,
      handle.workspacePath,
    );
    const currentByPath = new Map(current.files.map((file) => [file.path, file]));
    const paths = new Set([...handle.materializedPaths, ...currentByPath.keys()]);
    const files: ChangedFileManifest["files"] = [];
    for (const filePath of [...paths].sort()) {
      const before = handle.baseManifest.get(filePath);
      const after = currentByPath.get(filePath);
      if (!before && after) files.push({ ...after, change: "added" });
      else if (before && !after) files.push({ ...before, change: "deleted" });
      else if (before && after && before.sha256 !== after.sha256) {
        files.push({ ...after, change: "modified" });
      }
    }
    return {
      files,
      scopeViolations: files
        .map((file) => file.path)
        .filter((filePath) => !isAllowed(filePath, handle.allowedPaths)),
    };
  }

  async mainWorkspaceDrift(
    handle: WorkerWorkspace,
    changedPaths: string[],
  ): Promise<string[]> {
    const current = await new ApplicationMapBuilder().build(
      handle.orchestrationId,
      handle.baseWorkspacePath,
    );
    const byPath = new Map(current.files.map((file) => [file.path, file.sha256]));
    return changedPaths.filter(
      (filePath) => byPath.get(filePath) !== handle.baseManifest.get(filePath)?.sha256,
    );
  }

  async applyChanges(
    handle: WorkerWorkspace,
    destination: string,
    manifest: ChangedFileManifest,
  ): Promise<void> {
    const destinationRoot = await realpath(destination);
    for (const file of manifest.files) {
      if (isProtectedRelativePath(file.path)) throw new Error("Refusing to apply a protected path");
      const target = path.resolve(destinationRoot, file.path);
      if (!target.startsWith(destinationRoot + path.sep)) throw new Error("Change path escaped destination");
      if (file.change === "deleted") {
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        const source = path.join(handle.workspacePath, file.path);
        const content = await readFile(source);
        await writeFile(target, content, { mode: (await stat(source)).mode & 0o777 });
      }
    }
  }

  async cleanup(
    handle: WorkerWorkspace,
    policy: "clean" | "archive",
  ): Promise<{ disposition: "cleaned" | "archived"; path: string | null }> {
    const trustedRoot = await realpath(this.tempRoot);
    const target = await realpath(handle.executionRoot).catch(() => path.resolve(handle.executionRoot));
    if (target === trustedRoot || !target.startsWith(trustedRoot + path.sep)) {
      throw new Error("Unsafe cleanup target rejected");
    }
    if (policy === "archive") {
      const destination = path.join(
        path.resolve(this.archiveRoot),
        `${safeSegment(handle.orchestrationId)}-${safeSegment(handle.taskId)}-${Date.now()}`,
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await rename(target, destination);
      return { disposition: "archived", path: destination };
    }
    await rm(target, { recursive: true, force: true });
    return { disposition: "cleaned", path: null };
  }
}
