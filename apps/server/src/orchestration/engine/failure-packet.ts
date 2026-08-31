import type {
  FailurePacket,
  TokenUsage,
  VerificationRecord,
} from "../contracts.js";
import type { WorkspaceChanges } from "./worker-workspaces.js";

export type FailureClassification =
  | "implementation-bug"
  | "missing-context"
  | "stale-dependency"
  | "weak-model"
  | "invalid-plan"
  | "ambiguous-contract"
  | "suspected-bad-check"
  | "infrastructure-failure"
  | "budget-exhaustion";

export function createFailurePacket(input: {
  taskId: string;
  contractVersion: number;
  attemptCount: number;
  error: string;
  verifications: VerificationRecord[];
  changes: WorkspaceChanges;
  relevantInterfaces: string[];
  diagnosis: string;
  usage: TokenUsage;
}): FailurePacket {
  return {
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    attemptCount: input.attemptCount,
    lastError: input.error.slice(0, 1_200),
    failingChecks: input.verifications
      .filter((record) => record.status === "failed")
      .map((record) => `${record.commandOrCheck}: ${record.outputSummary.slice(0, 300)}`)
      .slice(0, 12),
    changedFiles: [...input.changes.changedFiles, ...input.changes.deletedFiles].slice(0, 100),
    diffSummary: `${input.changes.changedFiles.length} changed, ${input.changes.deletedFiles.length} deleted`,
    relevantInterfaces: input.relevantInterfaces.slice(0, 50),
    workerDiagnosis: input.diagnosis.slice(0, 1_000),
    usage: input.usage,
  };
}

export function classifyFailure(packet: FailurePacket): FailureClassification {
  const text = `${packet.lastError} ${packet.workerDiagnosis} ${packet.failingChecks.join(" ")}`.toLowerCase();
  if (/argument list too long|\be2big\b|\/sbin\/docker-init/.test(text)) return "infrastructure-failure";
  if (/budget|token|cost|call limit|time limit/.test(text)) return "budget-exhaustion";
  if (/missing context|not found|cannot find module/.test(text)) return "missing-context";
  if (/stale|version|schema mismatch/.test(text)) return "stale-dependency";
  if (/ambiguous|unclear requirement/.test(text)) return "ambiguous-contract";
  if (/bad check|incorrect test|evaluator/.test(text)) return "suspected-bad-check";
  if (/plan|scope|dependency cycle/.test(text)) return "invalid-plan";
  if (/model|capability/.test(text)) return "weak-model";
  return "implementation-bug";
}
