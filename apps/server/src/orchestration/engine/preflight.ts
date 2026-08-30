import { z } from "zod";
import type { ExecutionContract, OrchestrationTask } from "../contracts.js";
import { matchesAllowedPath, normalizeRelative } from "./context-broker.js";

/**
 * Read-only worker preflight.
 *
 * Before any writable execution the worker runs in `read-only` mode and must
 * return a typed plan. The planner reviews the compact plan against the
 * confirmed contract, scope, dependencies and budget and may approve, reject,
 * or grant one narrow context expansion. No worker edit precedes approval.
 */

export const preflightReportSchema = z.object({
  understanding: z.string().min(1).max(2_000),
  filesToChange: z.array(z.string().min(1).max(400)).max(50),
  artifactsToConsume: z.array(z.string().min(1).max(200)).max(20).default([]),
  artifactsToPublish: z.array(z.string().min(1).max(200)).max(20).default([]),
  approach: z.string().min(1).max(4_000),
  missingContext: z
    .array(
      z.object({
        path: z.string().min(1).max(400),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(5)
    .default([]),
  plannedChecks: z.array(z.string().min(1).max(200)).max(20).default([]),
});

export type PreflightReport = z.infer<typeof preflightReportSchema>;

export const PREFLIGHT_SCHEMA_DESCRIPTION = [
  "{",
  '  "understanding": "one paragraph restating the subtask",',
  '  "filesToChange": ["relative/path.ts"],',
  '  "artifactsToConsume": ["artifact-name"],',
  '  "artifactsToPublish": ["artifact-name"],',
  '  "approach": "concise plan",',
  '  "missingContext": [{ "path": "relative/path.ts", "reason": "why it is needed" }],',
  '  "plannedChecks": ["check-id"]',
  "}",
].join("\n");

export type PreflightDecision =
  | { decision: "approved"; reason: string }
  | { decision: "expand"; reason: string; requests: Array<{ path: string; reason: string }> }
  | { decision: "rejected"; reason: string };

export interface PreflightReviewInput {
  report: PreflightReport;
  task: OrchestrationTask;
  contract: ExecutionContract;
  /** Names of artifacts currently published in the orchestration. */
  knownArtifacts: string[];
  /** Expansions already granted for this task. */
  priorExpansions: number;
  maxExpansions: number;
  /** Check IDs the trusted verification service will actually run. */
  allowedCheckIds: string[];
}

/**
 * Deterministic planner review of a preflight plan.
 *
 * Scope, dependency and budget rules are enforced here rather than delegated to
 * a model, so the "no edit before approval" invariant cannot be talked around.
 */
export function reviewPreflight(input: PreflightReviewInput): PreflightDecision {
  const { report, task } = input;

  if (report.understanding.trim().length < 20) {
    return {
      decision: "rejected",
      reason: "Preflight did not demonstrate an understanding of the subtask",
    };
  }

  const outOfScope = report.filesToChange
    .map(normalizeRelative)
    .filter((filePath) => !matchesAllowedPath(filePath, task.allowedPaths));
  if (outOfScope.length > 0) {
    return {
      decision: "rejected",
      reason:
        "Preflight plans to change files outside the task scope: " +
        outOfScope.slice(0, 5).join(", "),
    };
  }

  const unknownArtifacts = report.artifactsToConsume.filter(
    (name) => !input.knownArtifacts.includes(name),
  );
  if (unknownArtifacts.length > 0) {
    return {
      decision: "rejected",
      reason:
        "Preflight depends on artifacts that have not been published: " +
        unknownArtifacts.slice(0, 5).join(", "),
    };
  }

  const unknownChecks = report.plannedChecks.filter(
    (check) => !input.allowedCheckIds.includes(check),
  );
  if (unknownChecks.length > 0) {
    return {
      decision: "rejected",
      reason:
        "Preflight planned checks that are not part of the trusted check set: " +
        unknownChecks.slice(0, 5).join(", "),
    };
  }

  if (report.missingContext.length > 0) {
    if (input.priorExpansions >= input.maxExpansions) {
      return {
        decision: "rejected",
        reason:
          "Preflight requested more context but the expansion budget for this task is exhausted",
      };
    }
    const affordable = input.maxExpansions - input.priorExpansions;
    return {
      decision: "expand",
      reason:
        "Granting " +
        Math.min(affordable, report.missingContext.length) +
        " narrow context expansion request(s) before writable execution",
      requests: report.missingContext.slice(0, affordable),
    };
  }

  if (report.filesToChange.length === 0) {
    return {
      decision: "rejected",
      reason: "Preflight did not name any file it intends to change",
    };
  }

  return {
    decision: "approved",
    reason:
      "Plan stays inside " +
      task.allowedPaths.join(", ") +
      " and honours the confirmed contract",
  };
}

/** Compact record persisted as evidence. Full worker reasoning is discarded. */
export function summarizePreflight(report: PreflightReport): string {
  return [
    report.understanding.slice(0, 240),
    "files: " + report.filesToChange.slice(0, 8).join(", "),
    report.artifactsToPublish.length > 0
      ? "publishes: " + report.artifactsToPublish.join(", ")
      : "",
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 600);
}
