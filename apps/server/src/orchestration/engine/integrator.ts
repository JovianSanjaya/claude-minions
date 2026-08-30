import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

  async integrate(
    orchestrationId: string,
    sourceWorkspace: string,
    workers: IntegrationInput[],
    resolveConflict?: ConflictResolver,
  ): Promise<IntegrationCandidate> {
    const staging = path.join(
      this.tempRoot,
      orchestrationId.replace(/[^A-Za-z0-9_.-]/g, "-"),
      "integration",
    );
    await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await copyWorkspaceTree(sourceWorkspace, staging);
    const base = await workspaceManifest(sourceWorkspace);
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
    if (conflicts.length && !resolveConflict) {
      return {
        path: staging,
        base,
        manifest: await workspaceManifest(staging),
        changes: diffManifest(base, await workspaceManifest(staging)),
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

  async cleanup(candidate: IntegrationCandidate): Promise<void> {
    const root = await realpath(this.tempRoot);
    const target = await realpath(candidate.path);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("Refusing unsafe integration cleanup target");
    }
    await rm(target, { recursive: true, force: false });
  }

  async archive(candidate: IntegrationCandidate, archiveRoot: string): Promise<string> {
    const root = await realpath(this.tempRoot);
    const target = await realpath(candidate.path);
    if (target === root || !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("Refusing unsafe integration archive target");
    }
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    const archive = await realpath(archiveRoot);
    const orchestrationSegment = path.basename(path.dirname(target));
    const destination = path.join(archive, `${orchestrationSegment}-integration-candidate-${Date.now()}`);
    if (destination === archive || !destination.startsWith(`${archive}${path.sep}`)) {
      throw new Error("Refusing unsafe integration archive target");
    }
    await rename(target, destination);
    return destination;
  }
}
