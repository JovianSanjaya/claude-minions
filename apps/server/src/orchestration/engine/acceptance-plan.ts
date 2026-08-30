import { z } from "zod";
import type { ExecutionContract } from "../contracts.js";

export const plannedAcceptanceTestSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  criterionIds: z.array(z.string().min(1).max(200)).max(100).default([]),
  category: z.enum(["functional", "architectural", "scope", "runtime", "regression", "manual"]),
  scope: z.enum(["protected", "global", "manual"]),
  procedure: z.string().min(1).max(8_000),
  expectedOutcome: z.string().min(1).max(4_000),
}).strict();

export const protectedAcceptancePlanSchema = z.object({
  orchestrationId: z.string().min(1),
  contractVersion: z.number().int().positive(),
  generatedBy: z.literal("planner"),
  tests: z.array(plannedAcceptanceTestSchema).min(1).max(200),
}).strict();

export type PlannedAcceptanceTest = z.infer<typeof plannedAcceptanceTestSchema>;
export type ProtectedAcceptancePlan = z.infer<typeof protectedAcceptancePlanSchema>;

function safeTestId(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 200) || "acceptance-test";
}

const orchestrationProcessPatterns = [
  /platform(?:'s)? built-in (?:final )?verifier/i,
  /worker[- ]routing selection configured in the dashboard/i,
  /report the generated files and verification results/i,
  /separate testing or verification (?:implementation )?(?:task|worker)/i,
  /^required automated checks pass in the trusted verification environment$/i,
];

function concernsOrchestrationProcess(value: string): boolean {
  return orchestrationProcessPatterns.some((pattern) => pattern.test(value));
}

export function comprehensiveAcceptanceTests(
  proposed: readonly PlannedAcceptanceTest[],
  contract: ExecutionContract,
): PlannedAcceptanceTest[] {
  const criteria = new Map(
    contract.criteria
      .filter((criterion) => !concernsOrchestrationProcess(criterion.description))
      .map((criterion) => [criterion.id, criterion]),
  );
  const usedIds = new Set<string>();
  const normalized: PlannedAcceptanceTest[] = [];
  for (const proposedTest of proposed) {
    const testText = `${proposedTest.title}\n${proposedTest.procedure}\n${proposedTest.expectedOutcome}`;
    if (concernsOrchestrationProcess(testText)) continue;
    const criterionIds = [...new Set(proposedTest.criterionIds.filter((criterionId) => criteria.has(criterionId)))];
    // Every blocking planner-generated check must be traceable to a confirmed
    // deliverable criterion. Platform-wide checks are owned by VerificationService.
    if (!criterionIds.length) continue;
    let id = safeTestId(proposedTest.id);
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${safeTestId(proposedTest.id)}-${suffix}`;
    usedIds.add(id);
    normalized.push({ ...proposedTest, id, criterionIds });
  }

  const covered = new Set(normalized.flatMap((test) => test.criterionIds));
  for (const criterion of criteria.values()) {
    if (covered.has(criterion.id)) continue;
    const manual = criterion.verification === "manual" || criterion.kind === "manual";
    let id = safeTestId(`criterion-${criterion.id}`);
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${safeTestId(`criterion-${criterion.id}`)}-${suffix}`;
    usedIds.add(id);
    normalized.push({
      id,
      title: `Verify: ${criterion.description}`.slice(0, 500),
      criterionIds: [criterion.id],
      category: manual ? "manual" : criterion.kind,
      scope: manual ? "manual" : criterion.verification === "protected-test" ? "protected" : "global",
      procedure: manual
        ? `A human reviewer must evaluate this confirmed criterion: ${criterion.description}`
        : `Inspect the integrated candidate and run the most direct non-destructive check that proves this confirmed criterion: ${criterion.description}`,
      expectedOutcome: criterion.description,
    });
  }

  return normalized.slice(0, 200);
}
