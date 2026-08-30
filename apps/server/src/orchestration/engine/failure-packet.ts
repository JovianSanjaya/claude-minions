import type {
  ExecutionContract,
  FailurePacket,
  OrchestrationTask,
  TokenUsage,
  VerificationRecord,
} from "../contracts.js";

export type FailureClassification =
  | "implementation-bug"
  | "missing-context"
  | "stale-dependency"
  | "weak-model"
  | "invalid-plan"
  | "ambiguous-contract"
  | "suspected-bad-check"
  | "budget-exhaustion";

const MAX_ERROR_CHARS = 2_000;
const MAX_CHECK_SUMMARY_CHARS = 300;

export function buildFailurePacket(
  task: OrchestrationTask,
  contract: ExecutionContract,
  attemptCount: number,
  changedFiles: string[],
  failingChecks: VerificationRecord[],
  lastError: string,
  usage: TokenUsage,
): FailurePacket {
  return {
    taskId: task.id,
    contractVersion: contract.version,
    attemptCount,
    lastError: lastError.slice(0, MAX_ERROR_CHARS),
    failingChecks: failingChecks.map(
      (check) => `${check.commandOrCheck}: ${check.outputSummary.slice(0, MAX_CHECK_SUMMARY_CHARS)}`,
    ),
    changedFiles,
    diffSummary: `${changedFiles.length} file(s) touched`,
    relevantInterfaces: [],
    workerDiagnosis: lastError.slice(0, 500),
    usage,
  };
}

/**
 * Deterministic keyword-based classification, not a claim of semantic
 * understanding — this is a first-pass triage the planner (or, in a fuller
 * build, a planner model call) uses to decide replan/expand-context/
 * refresh-dependency/escalate/stop. It is intentionally conservative:
 * unmatched failures fall through to "implementation-bug" rather than a
 * more consequential category like "ambiguous-contract".
 */
export function classifyFailure(packet: FailurePacket, budgetExhausted: boolean): FailureClassification {
  if (budgetExhausted) return "budget-exhaustion";
  if (packet.attemptCount === 0) return "invalid-plan";

  const text = `${packet.lastError} ${packet.failingChecks.join(" ")}`.toLowerCase();
  if (text.includes("stale") || text.includes("out of date") || text.includes("drift")) {
    return "stale-dependency";
  }
  if (text.includes("missing") && text.includes("context")) {
    return "missing-context";
  }
  if (text.includes("ambiguous") || text.includes("unclear requirement") || text.includes("contract conflict")) {
    return "ambiguous-contract";
  }
  if (text.includes("evaluator") || text.includes("bad check") || text.includes("check appears wrong")) {
    return "suspected-bad-check";
  }
  if (packet.attemptCount >= 3) return "weak-model";
  return "implementation-bug";
}
