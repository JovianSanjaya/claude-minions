import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionContract, OrchestrationTask, VerificationRecord } from "../contracts.js";
import { callRole, describeError, type RoleExecutorDeps } from "./role-executor.js";
import type { CheckDefinition, CheckRunner } from "./verification.js";
import { allPassed, runChecks } from "./verification.js";
import {
  buildManifest,
  createTaskWorkspace,
  manifestsDiffer,
  type TaskWorkspace,
  type WorkspaceManifest,
} from "./worker-workspaces.js";

export interface WorkerResult {
  task: OrchestrationTask;
  workspace: TaskWorkspace;
  changedFiles: string[];
}

export interface IntegrationInput {
  mainWorkspacePath: string;
  /** Manifest of the main workspace captured once, before any worker started — used to detect user edits during execution. */
  baseManifest: WorkspaceManifest;
  workerResults: WorkerResult[];
}

export interface IntegrationDeps {
  scratchRoot: string;
  checkRunner: CheckRunner;
  roleDeps: RoleExecutorDeps;
  protectedChecks: CheckDefinition[];
  globalChecks: CheckDefinition[];
}

export type IntegrationStatus = "published" | "conflict-unresolved" | "drift" | "verification-failed";

export interface IntegrationResult {
  status: IntegrationStatus;
  stagingPath: string | null;
  changedFiles: string[];
  conflicts: string[];
  verifications: VerificationRecord[];
}

async function copyFileInto(sourceRoot: string, destRoot: string, relativePath: string): Promise<void> {
  const sourcePath = path.join(sourceRoot, relativePath);
  const destPath = path.join(destRoot, relativePath);
  try {
    const content = await readFile(sourcePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, content);
  } catch {
    // source file no longer exists (worker deleted it) — remove from destination if present
    await rm(destPath, { force: true }).catch(() => undefined);
  }
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "(file not present)";
  }
}

function buildConflictPrompt(file: string, contents: Array<{ taskId: string; content: string }>): string {
  const sections = contents
    .map((entry) => `--- version from task ${entry.taskId} ---\n${entry.content}`)
    .join("\n\n");
  return [
    `Two workers both changed "${file}" and their versions conflict.`,
    "Reconcile them into one final version that satisfies both tasks' intent.",
    "Write the reconciled file directly to this workspace at the same path.",
    "",
    sections,
  ].join("\n");
}

/**
 * Deterministic-first integration: files touched by exactly one worker are
 * applied directly (no model call). Only files touched by more than one
 * worker go to a focused integrator role call — scoped to just the
 * conflicting files, never the full worker transcripts. Main-workspace
 * drift (a human or another process changed the workspace while workers
 * were running) is detected before anything is merged and always halts
 * rather than overwrites. Publication to the real Agent workspace happens
 * only after protected/global verification passes on the staged candidate.
 */
export async function integrate(
  deps: IntegrationDeps,
  orchestrationId: string,
  agentId: string,
  contract: ExecutionContract,
  input: IntegrationInput,
  signal: AbortSignal,
): Promise<IntegrationResult> {
  const currentMainManifest = await buildManifest(input.mainWorkspacePath);
  if (manifestsDiffer(input.baseManifest, currentMainManifest)) {
    return { status: "drift", stagingPath: null, changedFiles: [], conflicts: [], verifications: [] };
  }

  const staging = await createTaskWorkspace(
    deps.scratchRoot,
    orchestrationId,
    "integration",
    input.mainWorkspacePath,
  );

  const ownersByFile = new Map<string, string[]>();
  for (const result of input.workerResults) {
    for (const file of result.changedFiles) {
      const owners = ownersByFile.get(file) ?? [];
      owners.push(result.task.id);
      ownersByFile.set(file, owners);
    }
  }
  const conflicts = [...ownersByFile.entries()].filter(([, owners]) => owners.length > 1).map(([file]) => file);

  const changedFiles: string[] = [];
  for (const [file, owners] of ownersByFile) {
    if (owners.length > 1) continue;
    const ownerTaskId = owners[0];
    const owner = input.workerResults.find((result) => result.task.id === ownerTaskId);
    if (!owner) continue;
    await copyFileInto(owner.workspace.path, staging.path, file);
    changedFiles.push(file);
  }

  for (const file of conflicts) {
    if (signal.aborted) {
      return { status: "conflict-unresolved", stagingPath: staging.path, changedFiles, conflicts, verifications: [] };
    }
    const owners = ownersByFile.get(file) ?? [];
    const contents = await Promise.all(
      owners.map(async (taskId) => {
        const owner = input.workerResults.find((result) => result.task.id === taskId);
        return { taskId, content: owner ? await safeReadFile(path.join(owner.workspace.path, file)) : "" };
      }),
    );
    try {
      await callRole(deps.roleDeps, {
        agentId,
        orchestrationId,
        taskId: null,
        role: "integrator",
        prompt: buildConflictPrompt(file, contents),
        workspacePath: staging.path,
        threadId: null,
        estimatedInputTokens: 600,
        estimatedOutputTokens: 400,
        signal,
        sandboxMode: "workspace-write",
      });
      changedFiles.push(file);
    } catch (error) {
      const record: VerificationRecord = {
        id: `unresolved-${file}-${Date.now()}`,
        orchestrationId,
        taskId: null,
        scope: "global",
        commandOrCheck: `integrator-conflict:${file}`,
        status: "failed",
        outputSummary: describeError(error),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      await deps.roleDeps.sink.recordVerification(record);
      return {
        status: "conflict-unresolved",
        stagingPath: staging.path,
        changedFiles,
        conflicts,
        verifications: [record],
      };
    }
  }

  const verifications = await runChecks(
    orchestrationId,
    null,
    [...deps.protectedChecks, ...deps.globalChecks],
    staging.path,
    deps.checkRunner,
    deps.roleDeps.sink,
  );
  if (!allPassed(verifications)) {
    return { status: "verification-failed", stagingPath: staging.path, changedFiles, conflicts, verifications };
  }

  for (const file of [...new Set(changedFiles)]) {
    await copyFileInto(staging.path, input.mainWorkspacePath, file);
  }

  return { status: "published", stagingPath: staging.path, changedFiles: [...new Set(changedFiles)], conflicts, verifications };
}
