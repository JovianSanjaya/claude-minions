import { z } from "zod";

export const recoveryClassificationSchema = z.enum([
  "implementation-defect",
  "integration-defect",
  "verification-strategy",
  "environment-capability",
  "permission-required",
  "missing-context",
  "transient-failure",
  "invalid-plan",
  "non-recoverable",
]);

export const recoveryActionSchema = z.enum([
  "retry-direct",
  "retry-worker",
  "retry-integrator",
  "retry-verifier",
  "needs-user",
  "stop",
]);

export const recoveryDecisionSchema = z.object({
  classification: recoveryClassificationSchema,
  action: recoveryActionSchema,
  reason: z.string().min(1).max(4_000),
  instructions: z.string().max(8_000).default(""),
  targetTaskIds: z.array(z.string().min(1).max(200)).max(20).default([]),
  userQuestion: z.string().min(1).max(4_000).nullable().default(null),
}).strict();

export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;

export function recoveryEvidence(
  records: ReadonlyArray<{
    commandOrCheck: string;
    status: "passed" | "failed" | "skipped";
    outputSummary: string;
  }>,
): string {
  return JSON.stringify(
    records
      .filter((record) => record.status === "failed")
      .map((record) => ({
        check: record.commandOrCheck,
        evidence: record.outputSummary.slice(0, 8_000),
      })),
  ).slice(0, 80_000);
}

export function looksUserActionableFailure(value: string): boolean {
  return /permission|operation not permitted|access denied|credential|authentication|authorization|sandbox|user approval|user action|sign[ -]?in/i.test(value);
}
