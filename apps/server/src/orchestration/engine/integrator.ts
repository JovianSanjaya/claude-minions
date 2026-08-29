import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionContract,
  OrchestrationSink,
  OrchestrationTask,
  VerificationRecord,
} from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";
import { ApplicationMapBuilder, isProtectedRelativePath } from "./application-map.js";
import { BudgetDeniedError, RoleExecutor } from "./role-executor.js";
import { VerificationService } from "./verification.js";
import {
  WorkerWorkspaceManager,
  type ChangedFileManifest,
  type WorkerWorkspace,
} from "./worker-workspaces.js";

export interface IntegratableWorkerResult {
  task: OrchestrationTask;
  workspace: WorkerWorkspace;
  manifest: ChangedFileManifest;
}

export type IntegrationResult =
  | { kind: "published"; changedFiles: string[]; summary: string }
  | { kind: "needs-user"; reason: string }
  | { kind: "budget-exhausted"; reason: string }
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string };

interface ChangeSource {
  worker: IntegratableWorkerResult;
  change: ChangedFileManifest["files"][number];
}

function sameChange(left: ChangeSource, right: ChangeSource): boolean {
  return left.change.change === right.change.change && left.change.sha256 === right.change.sha256;
}

export class Integrator {
  constructor(
    private readonly roles: RoleExecutor,
    private readonly workspaces: WorkerWorkspaceManager,
    private readonly verification: VerificationService,
  ) {}

  async integrate(input: {
    orchestrationId: string;
    agentId: string;
    contract: ExecutionContract;
    map: ApplicationMap;
    workers: IntegratableWorkerResult[];
    sink: OrchestrationSink;
    signal: AbortSignal;
  }): Promise<IntegrationResult> {
    if (input.signal.aborted) return { kind: "cancelled", reason: "Orchestration cancelled" };
    const integrationTask: OrchestrationTask = {
      id: "integration",
      orchestrationId: input.orchestrationId,
      title: "Deterministic integration",
      objective: "Combine verified worker manifests without publishing unverified changes.",
      status: "running",
      dependsOn: input.workers.map((worker) => worker.task.id),
      allowedPaths: ["."],
      acceptanceCriterionIds: input.contract.criteria.map((criterion) => criterion.id),
      requiredArtifactIds: [],
      observedArtifactVersions: {},
      applicationMapVersion: input.map.summary.version,
      attemptCount: 0,
    };
    const candidate = await this.workspaces.create(
      input.orchestrationId,
      integrationTask,
      input.map,
    );
    try {
      const driftPaths = [...new Set(input.workers.flatMap((worker) => worker.manifest.files.map((file) => file.path)))];
      const drift = await this.workspaces.mainWorkspaceDrift(candidate, driftPaths);
      if (drift.length > 0) {
        await input.sink.recordEvent({
          orchestrationId: input.orchestrationId,
          taskId: null,
          executionId: null,
          type: "integration.workspace-drift",
          actorRole: "control-plane",
          modelId: null,
          summary: "The Agent workspace changed after orchestration began; publication was blocked.",
          metadata: { conflictingFiles: drift.length },
        });
        return { kind: "needs-user", reason: `Workspace drift detected in: ${drift.join(", ")}` };
      }

      const byPath = new Map<string, ChangeSource[]>();
      for (const worker of input.workers) {
        for (const change of worker.manifest.files) {
          const sources = byPath.get(change.path) ?? [];
          sources.push({ worker, change });
          byPath.set(change.path, sources);
        }
      }
      const conflicts: Array<{ path: string; sources: ChangeSource[] }> = [];
      for (const [filePath, sources] of byPath) {
        const first = sources[0];
        if (!first) continue;
        if (sources.every((source) => sameChange(first, source))) {
          await this.workspaces.applyChanges(first.worker.workspace, candidate.workspacePath, {
            files: [first.change],
            scopeViolations: [],
          });
        } else {
          conflicts.push({ path: filePath, sources });
        }
      }

      if (conflicts.length > 0) {
        const beforeConflictMap = await new ApplicationMapBuilder().build(
          input.orchestrationId,
          candidate.workspacePath,
        );
        const conflictPacket: string[] = [];
        for (const conflict of conflicts) {
          conflictPacket.push(`Conflict: ${conflict.path}`);
          for (const source of conflict.sources) {
            const content =
              source.change.change === "deleted"
                ? "[deleted]"
                : (await readFile(path.join(source.worker.workspace.workspacePath, conflict.path), "utf8")).slice(0, 20_000);
            conflictPacket.push(`Task ${source.worker.task.id} variant (${source.change.change}):\n${content}`);
          }
        }
        try {
          await this.roles.callText({
            orchestrationId: input.orchestrationId,
            taskId: null,
            agentId: input.agentId,
            role: "integrator",
            prompt: [
              "Resolve only the listed conflicting files in the isolated integration candidate.",
              "Preserve the confirmed contract. Do not change non-conflicting paths.",
              `Contract: ${input.contract.criteria.map((criterion) => `${criterion.id}: ${criterion.description}`).join(" | ")}`,
              ...conflictPacket,
            ].join("\n\n"),
            workspacePath: candidate.workspacePath,
            sandboxMode: "workspace-write",
            estimatedInputTokens: Math.ceil(conflictPacket.join("\n").length / 4) + 1_000,
            estimatedOutputTokens: 1_500,
            sink: input.sink,
            signal: input.signal,
          });
        } catch (error) {
          if (error instanceof BudgetDeniedError) {
            return { kind: "budget-exhausted", reason: error.reason };
          }
          throw error;
        }
        const afterConflictMap = await new ApplicationMapBuilder().build(
          input.orchestrationId,
          candidate.workspacePath,
        );
        const beforeByPath = new Map(
          beforeConflictMap.files.map((file) => [file.path, file.sha256]),
        );
        const afterByPath = new Map(
          afterConflictMap.files.map((file) => [file.path, file.sha256]),
        );
        const modelChangedPaths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
          .filter((filePath) => beforeByPath.get(filePath) !== afterByPath.get(filePath));
        const focusedPaths = new Set(conflicts.map((conflict) => conflict.path));
        const unrelated = modelChangedPaths.filter((filePath) => !focusedPaths.has(filePath));
        if (unrelated.length > 0) {
          return {
            kind: "failed",
            reason: `Integrator changed files outside the focused conflict packet: ${unrelated.join(", ")}`,
          };
        }
      }

      const candidateManifest = await this.workspaces.inspect(candidate);
      if (candidateManifest.scopeViolations.length > 0) {
        return {
          kind: "failed",
          reason: `Integrator changed paths outside the focused packet: ${candidateManifest.scopeViolations.join(", ")}`,
        };
      }
      await input.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: null,
        executionId: null,
        type: "integration.candidate-ready",
        actorRole: "integrator",
        modelId: null,
        summary: conflicts.length
          ? "Deterministic changes were applied and focused conflicts were reconciled."
          : "All worker manifests were reconciled deterministically without model conflict resolution.",
        metadata: {
          changedFiles: candidateManifest.files.length,
          conflicts: conflicts.length,
        },
      });

      const protectedResult = await this.verification.run({
        orchestrationId: input.orchestrationId,
        taskId: null,
        workspacePath: candidate.workspacePath,
        scopes: ["protected"],
        sink: input.sink,
        signal: input.signal,
      });
      const globalResult = await this.verification.run({
        orchestrationId: input.orchestrationId,
        taskId: null,
        workspacePath: candidate.workspacePath,
        scopes: ["global"],
        sink: input.sink,
        signal: input.signal,
      });
      const protectedRequired = input.contract.criteria.some(
        (criterion) => criterion.verification === "protected-test",
      );
      if (
        !globalResult.configured ||
        !globalResult.passed ||
        (protectedRequired && (!protectedResult.configured || !protectedResult.passed))
      ) {
        return {
          kind: "failed",
          reason: !globalResult.configured
            ? "No trusted global verification is configured; publication is forbidden"
            : "Protected or global verification failed; the main workspace was not changed",
        };
      }
      for (const criterion of input.contract.criteria.filter(
        (item) => item.verification === "manual",
      )) {
        const timestamp = new Date().toISOString();
        const record: VerificationRecord = {
          id: `manual-${criterion.id}`,
          orchestrationId: input.orchestrationId,
          taskId: null,
          scope: "manual",
          commandOrCheck: criterion.id,
          status: "skipped",
          outputSummary: `Manual acceptance remains explicitly required: ${criterion.description}`,
          startedAt: timestamp,
          completedAt: timestamp,
        };
        await input.sink.recordVerification(record);
      }

      const changedPaths = candidateManifest.files.map((file) => file.path);
      const finalDrift = await this.workspaces.mainWorkspaceDrift(candidate, changedPaths);
      if (finalDrift.length > 0) {
        return { kind: "needs-user", reason: `Workspace changed before publish: ${finalDrift.join(", ")}` };
      }
      await this.publishWithRollback(candidate, candidateManifest, input.map.rootPath);
      const refreshed = await new ApplicationMapBuilder().build(
        input.orchestrationId,
        input.map.rootPath,
        { version: input.map.summary.version + 1 },
      );
      await input.sink.recordApplicationMap(refreshed.summary);
      await input.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: null,
        executionId: null,
        type: "integration.published",
        actorRole: "control-plane",
        modelId: null,
        summary: `Published ${changedPaths.length} verified file changes to the Agent workspace.`,
        metadata: { changedFiles: changedPaths.length, applicationMapVersion: refreshed.summary.version },
      });
      return {
        kind: "published",
        changedFiles: changedPaths,
        summary: `Verified publication changed ${changedPaths.length} files.`,
      };
    } catch (error) {
      if (input.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return { kind: "cancelled", reason: "Orchestration cancelled" };
      }
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await this.workspaces.cleanup(candidate, "clean").catch(() => undefined);
    }
  }

  private async publishWithRollback(
    candidate: WorkerWorkspace,
    manifest: ChangedFileManifest,
    mainWorkspace: string,
  ): Promise<void> {
    const backupRoot = path.join(candidate.executionRoot, "publish-backup");
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const existed = new Set<string>();
    for (const change of manifest.files) {
      if (isProtectedRelativePath(change.path)) throw new Error("Protected path reached publication");
      const source = path.join(mainWorkspace, change.path);
      try {
        const info = await lstat(source);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("Unsafe publish target type");
        existed.add(change.path);
        const backup = path.join(backupRoot, change.path);
        await mkdir(path.dirname(backup), { recursive: true });
        await copyFile(source, backup);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    try {
      await this.workspaces.applyChanges(candidate, mainWorkspace, manifest);
    } catch (error) {
      for (const change of manifest.files) {
        const target = path.join(mainWorkspace, change.path);
        if (existed.has(change.path)) {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(path.join(backupRoot, change.path), target);
        } else {
          await rm(target, { force: true });
        }
      }
      throw error;
    }
  }
}
