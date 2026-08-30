import { randomUUID } from "node:crypto";
import type {
  BudgetPolicy,
  ExecutionContract,
  FailurePacket,
  OrchestrationTask,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import type { ContextPacket } from "./context-broker.js";
import { resolveExpansion, summarizeContext } from "./context-broker.js";
import { buildFailurePacket } from "./failure-packet.js";
import { runPreflight } from "./preflight.js";
import { BudgetDeniedError, callRole, describeError, type RoleExecutorDeps } from "./role-executor.js";
import type { CheckDefinition, CheckRunner } from "./verification.js";
import { allPassed, runChecks } from "./verification.js";
import { createTaskWorkspace, diffWorkspace, isPathWithinAllowed, type TaskWorkspace } from "./worker-workspaces.js";

export interface WorkerLoopDeps {
  roleDeps: RoleExecutorDeps;
  scratchRoot: string;
  checkRunner: CheckRunner;
}

export interface WorkerLoopResult {
  status: "passed" | "failed" | "cancelled";
  changedFiles: string[];
  attempts: number;
  failurePacket: FailurePacket | null;
  workspace: TaskWorkspace;
}

function buildWorkerPrompt(
  task: OrchestrationTask,
  contract: ExecutionContract,
  plan: { approach: string },
  grantedExpansions: string[],
): string {
  const relevantCriteria = contract.criteria
    .filter((criterion) => task.acceptanceCriterionIds.includes(criterion.id))
    .map((criterion) => `- (${criterion.kind}) ${criterion.description}`)
    .join("\n");
  return [
    `Implement task "${task.title}" within this isolated workspace.`,
    `Objective: ${task.objective}`,
    `Stay strictly within these paths: ${task.allowedPaths.join(", ") || "(no restriction specified)"}`,
    `Acceptance criteria for this task:\n${relevantCriteria || "(none listed)"}`,
    `Your approved approach: ${plan.approach}`,
    grantedExpansions.length > 0
      ? `Additional context you requested and were granted: ${grantedExpansions.join(", ")}`
      : "",
    "Make the necessary file changes now.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The bounded worker loop: read-only preflight and planner approval before
 * any writable call, then writable execution against an isolated workspace
 * copy, then worker-visible checks, retrying up to `budget.maxWorkerAttempts`
 * times. Real filesystem isolation and a real before/after diff — no
 * structured "list of edits" convention is used for the writable step,
 * because the real Codex CLI edits files directly as a side effect of
 * execution (this is exactly how the real `AgentRunner` behaves); a test
 * fake simulates the same thing by writing into `request.workspacePath`.
 */
export async function runWorkerLoop(
  deps: WorkerLoopDeps,
  orchestrationId: string,
  agentId: string,
  contract: ExecutionContract,
  task: OrchestrationTask,
  contextPacket: ContextPacket,
  mainWorkspacePath: string,
  budget: BudgetPolicy,
  signal: AbortSignal,
): Promise<WorkerLoopResult> {
  const workspace = await createTaskWorkspace(deps.scratchRoot, orchestrationId, task.id, mainWorkspacePath);
  await deps.roleDeps.sink.recordContextPacket(contextPacket.summary);

  let attemptNumber = 0;
  let lastError = "";
  let lastFailingChecks: VerificationRecord[] = [];
  let lastChangedFiles: string[] = [];
  // Expansion budget is per-task, spent across attempts (not reset each retry).
  let expansionsUsed = 0;

  while (attemptNumber < budget.maxWorkerAttempts) {
    if (signal.aborted) {
      return { status: "cancelled", changedFiles: lastChangedFiles, attempts: attemptNumber, failurePacket: null, workspace };
    }
    attemptNumber += 1;
    const executionId = randomUUID();
    const attemptRecord: WorkerAttempt = {
      id: randomUUID(),
      orchestrationId,
      taskId: task.id,
      number: attemptNumber,
      executionId,
      modelId: deps.roleDeps.modelIds.worker ?? deps.roleDeps.defaultModelId,
      contextFileHashes: contextPacket.files.map((file) => file.sha256),
      changedFiles: [],
      status: "running",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      errorSummary: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await deps.roleDeps.sink.recordAttempt(attemptRecord);

    const finishAttempt = async (status: "passed" | "failed", changedFiles: string[], errorSummary: string | null) => {
      attemptRecord.status = status;
      attemptRecord.changedFiles = changedFiles;
      attemptRecord.errorSummary = errorSummary;
      attemptRecord.completedAt = new Date().toISOString();
      await deps.roleDeps.sink.recordAttempt(attemptRecord);
    };

    let preflight;
    try {
      preflight = await runPreflight(deps.roleDeps, {
        agentId,
        orchestrationId,
        task,
        contract,
        contextSummary: summarizeContext(contextPacket),
        workspacePath: workspace.path,
        signal,
      });
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        await finishAttempt("failed", [], error.message);
        throw error;
      }
      lastError = describeError(error);
      await finishAttempt("failed", [], lastError);
      continue;
    }
    if (!preflight.review.approved) {
      lastError = `Preflight rejected: ${preflight.review.reason}`;
      await finishAttempt("failed", [], lastError);
      continue;
    }

    const grantedExpansions: string[] = [];
    for (const requestedPath of preflight.plan.missingContextRequests) {
      const decision = resolveExpansion(workspace.path, { requestedPath, reason: "worker preflight request" }, expansionsUsed, budget.maxContextExpansionsPerTask);
      if (decision.allowed) {
        expansionsUsed += 1;
        grantedExpansions.push(decision.resolvedRelativePath);
      }
      await deps.roleDeps.sink.recordEvent({
        orchestrationId,
        taskId: task.id,
        executionId,
        type: decision.allowed ? "context-expansion-granted" : "context-expansion-denied",
        actorRole: "control-plane",
        modelId: null,
        summary: decision.allowed
          ? `Granted narrow context expansion: ${decision.resolvedRelativePath}`
          : `Denied context expansion for "${requestedPath}": ${decision.reason}`,
        metadata: { requestedPath },
      });
    }

    try {
      await callRole(deps.roleDeps, {
        agentId,
        orchestrationId,
        taskId: task.id,
        role: "worker",
        prompt: buildWorkerPrompt(task, contract, preflight.plan, grantedExpansions),
        workspacePath: workspace.path,
        threadId: null,
        estimatedInputTokens: 800,
        estimatedOutputTokens: 600,
        signal,
        sandboxMode: "workspace-write",
      });
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        await finishAttempt("failed", [], error.message);
        throw error;
      }
      lastError = describeError(error);
      await finishAttempt("failed", [], lastError);
      continue;
    }

    const changedFiles = await diffWorkspace(workspace);
    lastChangedFiles = changedFiles;
    const scopeViolations = changedFiles.filter((file) => !isPathWithinAllowed(file, task.allowedPaths));
    if (scopeViolations.length > 0) {
      lastError = `Scope violation: changed files outside allowed paths (${task.allowedPaths.join(", ")}): ${scopeViolations.join(", ")}`;
      await finishAttempt("failed", changedFiles, lastError);
      continue;
    }

    const checks: CheckDefinition[] = [{ name: `${task.id}-visible`, scope: "worker-visible" }];
    const records = await runChecks(orchestrationId, task.id, checks, workspace.path, deps.checkRunner, deps.roleDeps.sink);
    lastFailingChecks = records.filter((record) => record.status !== "passed");

    if (allPassed(records)) {
      await finishAttempt("passed", changedFiles, null);
      return { status: "passed", changedFiles, attempts: attemptNumber, failurePacket: null, workspace };
    }

    lastError = `Visible checks failed: ${lastFailingChecks.map((record) => record.commandOrCheck).join(", ")}`;
    await finishAttempt("failed", changedFiles, lastError);
  }

  const packet = buildFailurePacket(
    task,
    contract,
    attemptNumber,
    lastChangedFiles,
    lastFailingChecks,
    lastError,
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
  return { status: "failed", changedFiles: lastChangedFiles, attempts: attemptNumber, failurePacket: packet, workspace };
}
