import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceChanges, WorkspaceManifest } from "./worker-workspaces.js";
import { copyWorkspaceTree, diffManifest, workspaceManifest } from "./worker-workspaces.js";

export interface IntegrationInput {
  taskId: string;
  workspacePath: string;
  changes: WorkspaceChanges;
}

export interface IntegrationCandidate {
  path: string;
  base: WorkspaceManifest;
  manifest: WorkspaceManifest;
  changes: WorkspaceChanges;
  conflicts: string[];
}

export interface ExecutionStage {
  path: string;
  base: WorkspaceManifest;
}

export type ConflictResolver = (input: {
  path: string;
  variants: Array<{ taskId: string; content: Buffer }>;
}) => Promise<Buffer>;

function safeRelative(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe integration path: ${file}`);
  }
  return normalized;
}

export class DeterministicIntegrator {
  constructor(private readonly tempRoot: string) {}

  private stagingPath(orchestrationId: string, name: "integration" | "execution-stage"): string {
    return path.join(
      this.tempRoot,
      orchestrationId.replace(/[^A-Za-z0-9_.-]/g, "-"),
      name,
    );
  }

  private async createStaging(
    orchestrationId: string,
    sourceWorkspace: string,
    name: "integration" | "execution-stage",
  ): Promise<ExecutionStage> {
    const staging = this.stagingPath(orchestrationId, name);
    await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await copyWorkspaceTree(sourceWorkspace, staging);
    return { path: staging, base: await workspaceManifest(sourceWorkspace) };
  }

  private async applyInputs(
    staging: string,
    workers: IntegrationInput[],
    resolveConflict?: ConflictResolver,
  ): Promise<string[]> {
    const variants = new Map<string, IntegrationInput[]>();
    for (const worker of workers) {
      for (const file of [...worker.changes.changedFiles, ...worker.changes.deletedFiles]) {
        const safe = safeRelative(file);
        const list = variants.get(safe) ?? [];
        list.push(worker);
        variants.set(safe, list);
      }
    }
    const conflicts: string[] = [];
    for (const [file, producers] of variants) {
      const destination = path.join(staging, file);
      const deletions = producers.filter((producer) => producer.changes.deletedFiles.includes(file));
      const distinctHashes = new Set(
        producers.map((producer) => producer.changes.hashes[file] ?? "[deleted]"),
      );
      if (distinctHashes.size === 1) {
        if (deletions.length) await rm(destination, { force: true });
        else {
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(path.join(producers[0]!.workspacePath, file), destination);
        }
        continue;
      }
      conflicts.push(file);
      if (!resolveConflict) continue;
      const content = await resolveConflict({
        path: file,
        variants: await Promise.all(
          producers
            .filter((producer) => !producer.changes.deletedFiles.includes(file))
            .map(async (producer) => ({
              taskId: producer.taskId,
              content: await readFile(path.join(producer.workspacePath, file)),
            })),
        ),
      });
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    return conflicts;
  }

  async createExecutionStage(
    orchestrationId: string,
    sourceWorkspace: string,
  ): Promise<ExecutionStage> {
    return this.createStaging(orchestrationId, sourceWorkspace, "execution-stage");
  }

  async applyExecutionWave(stage: ExecutionStage, workers: IntegrationInput[]): Promise<void> {
    const conflicts = await this.applyInputs(stage.path, workers);
    if (conflicts.length) {
      throw new Error(`Concurrent worker write conflict escaped scheduling: ${conflicts.join(", ")}`);
    }
  }

  async discardExecutionStage(orchestrationId: string): Promise<void> {
    await this.discardNamed(orchestrationId, "execution-stage");
  }

  async integrate(
    orchestrationId: string,
    sourceWorkspace: string,
    workers: IntegrationInput[],
    resolveConflict?: ConflictResolver,
  ): Promise<IntegrationCandidate> {
    return this.integrateWaves(
      orchestrationId,
      sourceWorkspace,
      [workers],
      resolveConflict,
    );
  }

  async integrateWaves(
    orchestrationId: string,
    sourceWorkspace: string,
    waves: IntegrationInput[][],
    resolveConflict?: ConflictResolver,
  ): Promise<IntegrationCandidate> {
    const { path: staging, base } = await this.createStaging(
      orchestrationId,
      sourceWorkspace,
      "integration",
    );
    const conflicts: string[] = [];
    for (const workers of waves) {
      conflicts.push(...await this.applyInputs(staging, workers, resolveConflict));
    }
    if (conflicts.length && !resolveConflict) {
      const manifest = await workspaceManifest(staging);
      return {
        path: staging,
        base,
        manifest,
        changes: diffManifest(base, manifest),
        conflicts,
      };
    }
    const manifest = await workspaceManifest(staging);
    return { path: staging, base, manifest, changes: diffManifest(base, manifest), conflicts };
  }

  async publish(candidate: IntegrationCandidate, mainWorkspace: string): Promise<string[]> {
    const current = await workspaceManifest(mainWorkspace);
    const touched = [...candidate.changes.changedFiles, ...candidate.changes.deletedFiles];
    if (!touched.length) return [];
    const drift = touched.filter((file) => current.files[file] !== candidate.base.files[file]);
    if (drift.length) {
      throw new Error(`Agent workspace changed during orchestration: ${drift.join(", ")}`);
    }
    const backupRoot = path.join(candidate.path, ".publish-backup");
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const originallyAbsent = new Set<string>();
    try {
      for (const file of touched) {
        const destination = path.join(mainWorkspace, safeRelative(file));
        if (current.files[file]) {
          const backup = path.join(backupRoot, file);
          await mkdir(path.dirname(backup), { recursive: true });
          await copyFile(destination, backup);
        } else originallyAbsent.add(file);
      }
      for (const file of candidate.changes.changedFiles) {
        const destination = path.join(mainWorkspace, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(candidate.path, file), destination);
      }
      for (const file of candidate.changes.deletedFiles) {
        await rm(path.join(mainWorkspace, file), { force: true });
      }
    } catch (error) {
      for (const file of touched) {
        const destination = path.join(mainWorkspace, file);
        if (originallyAbsent.has(file)) await rm(destination, { force: true });
        else await copyFile(path.join(backupRoot, file), destination).catch(() => undefined);
      }
      throw error;
    }
    return touched.sort();
  }

  async refresh(candidate: IntegrationCandidate): Promise<IntegrationCandidate> {
    const manifest = await workspaceManifest(candidate.path);
    return {
      ...candidate,
      manifest,
      changes: diffManifest(candidate.base, manifest),
    };
  }

  async discard(orchestrationId: string): Promise<void> {
    await this.discardNamed(orchestrationId, "integration");
  }

  private async discardNamed(
    orchestrationId: string,
    name: "integration" | "execution-stage",
  ): Promise<void> {
    const root = await realpath(this.tempRoot);
    const target = path.join(
      root,
      orchestrationId.replace(/[^A-Za-z0-9_.-]/g, "-"),
      name,
    );
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("Refusing unsafe integration discard target");
    }
    await rm(target, { recursive: true, force: true });
  }

  async cleanup(candidate: IntegrationCandidate): Promise<void> {
    const root = await realpath(this.tempRoot);
    const target = await realpath(candidate.path);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("Refusing unsafe integration cleanup target");
    }
    await rm(target, { recursive: true, force: false });
  }
}
