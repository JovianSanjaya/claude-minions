import type { FailurePacket, TokenUsage } from "../contracts.js";

export type FailureClassification =
  | "implementation-bug"
  | "missing-context"
  | "stale-dependency"
  | "weak-model"
  | "invalid-plan"
  | "ambiguous-contract"
  | "suspected-bad-check"
  | "budget-exhaustion";

function bounded(values: string[], count: number, width: number): string[] {
  return values.slice(0, count).map((value) => value.slice(0, width));
}

export function createFailurePacket(input: {
  taskId: string;
  contractVersion: number;
  attemptCount: number;
  lastError: string;
  failingChecks: string[];
  changedFiles: string[];
  diffSummary: string;
  relevantInterfaces: string[];
  workerDiagnosis: string;
  usage: TokenUsage;
}): FailurePacket {
  return {
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    attemptCount: input.attemptCount,
    lastError: input.lastError.slice(0, 2_000),
    failingChecks: bounded(input.failingChecks, 20, 1_000),
    changedFiles: bounded(input.changedFiles, 200, 400),
    diffSummary: input.diffSummary.slice(0, 4_000),
    relevantInterfaces: bounded(input.relevantInterfaces, 50, 500),
    workerDiagnosis: input.workerDiagnosis.slice(0, 2_000),
    usage: { ...input.usage },
  };
}

export function classifyFailure(packet: FailurePacket): FailureClassification {
  const text = [
    packet.lastError,
    packet.workerDiagnosis,
    ...packet.failingChecks,
  ]
    .join(" ")
    .toLowerCase();
  if (/budget|token limit|model.call limit|cost limit/.test(text)) return "budget-exhaustion";
  if (/stale|version mismatch|dependency drift/.test(text)) return "stale-dependency";
  if (/missing (?:file|context|interface)|not enough context/.test(text)) return "missing-context";
  if (/ambiguous|unclear requirement|needs user/.test(text)) return "ambiguous-contract";
  if (/test (?:is )?wrong|bad check|evaluator bug/.test(text)) return "suspected-bad-check";
  if (/plan|scope impossible|wrong task/.test(text)) return "invalid-plan";
  if (/model|capability|reasoning/.test(text)) return "weak-model";
  return "implementation-bug";
}
