import type { FailurePacket, TokenUsage } from "../contracts.js";

/**
 * Compact failure packets and planner diagnosis.
 *
 * After bounded local failure the worker's whole transcript is discarded and a
 * small, typed packet is escalated instead: what failed, what changed, which
 * interfaces were involved, and what was spent.
 */

export const MAX_ERROR_CHARS = 600;
export const MAX_FAILING_CHECKS = 8;
export const MAX_CHANGED_FILES = 20;
export const MAX_DIAGNOSIS_CHARS = 600;

export interface BuildFailurePacketInput {
  taskId: string;
  contractVersion: number;
  attemptCount: number;
  lastError: string;
  failingChecks: string[];
  changedFiles: string[];
  addedFiles?: string[];
  removedFiles?: string[];
  relevantInterfaces: string[];
  workerDiagnosis: string;
  usage: TokenUsage;
}

export function buildFailurePacket(input: BuildFailurePacketInput): FailurePacket {
  return {
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    attemptCount: input.attemptCount,
    lastError: truncate(input.lastError, MAX_ERROR_CHARS),
    failingChecks: input.failingChecks.slice(0, MAX_FAILING_CHECKS),
    changedFiles: input.changedFiles.slice(0, MAX_CHANGED_FILES),
    diffSummary: summarizeDiff(input),
    relevantInterfaces: input.relevantInterfaces.slice(0, 12),
    workerDiagnosis: truncate(input.workerDiagnosis, MAX_DIAGNOSIS_CHARS),
    usage: input.usage,
  };
}

function summarizeDiff(input: BuildFailurePacketInput): string {
  const added = input.addedFiles ?? [];
  const removed = input.removedFiles ?? [];
  const parts = [
    input.changedFiles.length + " modified",
    added.length + " added",
    removed.length + " removed",
  ];
  const sample = [...input.changedFiles, ...added].slice(0, 6);
  return (
    parts.join(", ") + (sample.length > 0 ? " (" + sample.join(", ") + ")" : "")
  ).slice(0, 400);
}

export type FailureClassification =
  | "implementation-bug"
  | "missing-context"
  | "stale-dependency"
  | "weak-model"
  | "invalid-plan"
  | "ambiguous-contract"
  | "suspected-bad-check"
  | "budget-exhaustion";

export type RecoveryAction =
  | "focused-replan"
  | "narrow-expansion"
  | "dependency-refresh"
  | "stronger-model"
  | "material-amendment"
  | "stop";

export interface DiagnosisContext {
  /** True when a required artifact moved while the task was running. */
  dependencyStale: boolean;
  /** Expansion requests the worker made that were denied or exhausted. */
  deniedExpansions: number;
  budgetDenied: boolean;
  scopeViolations: string[];
  attemptsAllowed: number;
  /** True when the worker produced no file change at all. */
  noChangesProduced: boolean;
  /** True when every attempt failed the same protected check. */
  repeatedProtectedFailure: boolean;
  /** True when the model repeatedly produced unusable structured output. */
  structuredOutputFailures: number;
}

export interface Diagnosis {
  classification: FailureClassification;
  action: RecoveryAction;
  reason: string;
}

/**
 * Deterministic classifier. It runs before (and independently of) any planner
 * model call so a failure is always classified even when the budget is gone.
 */
export function classifyFailure(
  packet: FailurePacket,
  context: DiagnosisContext,
): Diagnosis {
  if (context.budgetDenied) {
    return {
      classification: "budget-exhaustion",
      action: "stop",
      reason: "The hard budget denied further model calls for this task",
    };
  }
  if (context.dependencyStale) {
    return {
      classification: "stale-dependency",
      action: "dependency-refresh",
      reason: "A required shared artifact changed version during execution",
    };
  }
  if (context.scopeViolations.length > 0) {
    return {
      classification: "invalid-plan",
      action: "focused-replan",
      reason:
        "The worker changed files outside its allowed paths: " +
        context.scopeViolations.slice(0, 5).join(", "),
    };
  }
  if (context.deniedExpansions > 0 || context.noChangesProduced) {
    return {
      classification: "missing-context",
      action: "narrow-expansion",
      reason: context.noChangesProduced
        ? "The worker produced no file changes, which usually means it lacked the files it needed"
        : "The worker asked for context it did not receive",
    };
  }
  if (context.structuredOutputFailures >= 2) {
    return {
      classification: "weak-model",
      action: "stronger-model",
      reason:
        "The worker model repeatedly failed to produce a valid structured response",
    };
  }
  if (context.repeatedProtectedFailure && packet.changedFiles.length > 0) {
    return {
      classification: "suspected-bad-check",
      action: "material-amendment",
      reason:
        "The same protected check failed on every attempt despite substantive changes; the check itself must be reviewed rather than weakened",
    };
  }
  if (packet.failingChecks.length === 0 && packet.lastError.length === 0) {
    return {
      classification: "ambiguous-contract",
      action: "material-amendment",
      reason: "The task failed without a concrete failing check or error",
    };
  }
  return {
    classification: "implementation-bug",
    action: packet.attemptCount >= context.attemptsAllowed ? "focused-replan" : "focused-replan",
    reason:
      "Local checks failed after " +
      packet.attemptCount +
      " bounded attempt(s): " +
      (packet.failingChecks.join(", ") || packet.lastError.slice(0, 120)),
  };
}

/** One-line, safe rendering used in events and planner prompts. */
export function renderFailurePacket(packet: FailurePacket): string {
  return [
    "task=" + packet.taskId,
    "contract=v" + packet.contractVersion,
    "attempts=" + packet.attemptCount,
    "failingChecks=" + (packet.failingChecks.join("|") || "none"),
    "changed=" + packet.diffSummary,
    "interfaces=" + (packet.relevantInterfaces.join("|") || "none"),
    "error=" + packet.lastError,
    "diagnosis=" + packet.workerDiagnosis,
  ].join("\n");
}

function truncate(value: string, max: number): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "..." : trimmed;
}
