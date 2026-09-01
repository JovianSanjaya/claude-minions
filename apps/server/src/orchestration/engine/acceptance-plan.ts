import { z } from "zod";
import type { ExecutionContract } from "../contracts.js";

export const plannedAcceptanceTestSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  criterionIds: z.array(z.string().min(1).max(200)).max(100).default([]),
  category: z.enum(["functional", "architectural", "scope", "runtime", "regression", "manual"]),
  scope: z.enum(["protected", "global", "manual"]),
  verificationPhase: z.enum(["release-gate", "post-release"]).default("release-gate"),
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

const postReleaseObservationPatterns = [
  /\b(?:final|eventual)\s+(?:assistant|agent|chat)?\s*(?:response|reply|message|output)\b/i,
  /\b(?:assistant|agent|chat)\s+(?:response|reply|message)\s+(?:to|for)\s+(?:the\s+)?user\b/i,
  /\breview\s+(?:the\s+)?(?:assistant(?:'s)?|agent(?:'s)?)?\s*(?:final\s+)?(?:response|reply|message)\b/i,
  /\b(?:response|reply|message)\s+text\s+(?:is|was|will be)\b/i,
  /\b(?:inform|tell|notify|email|message)\s+(?:the\s+)?(?:user|customer|recipient)\b/i,
  /\b(?:after|once|following)\s+(?:the\s+)?(?:final\s+)?(?:verification|publication|publish|release|deployment)\b/i,
];

function describesPostReleaseObservation(...parts: string[]): boolean {
  const text = parts.join("\n");
  return postReleaseObservationPatterns.some((pattern) => pattern.test(text));
}

/**
 * Post-release effects cannot be evidence for the release gate that makes them
 * possible. The explicit planner classification is backed by deterministic
 * detection so older or incorrectly classified plans cannot create a circular
 * verification dependency.
 */
export function requiresPostReleaseVerification(
  test: Pick<PlannedAcceptanceTest, "verificationPhase" | "title" | "procedure" | "expectedOutcome">,
): boolean {
  return test.verificationPhase === "post-release" || describesPostReleaseObservation(
    test.title,
    test.procedure,
    test.expectedOutcome,
  );
}

function safeTestId(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 200) || "acceptance-test";
}

export function comprehensiveAcceptanceTests(
  proposed: readonly z.input<typeof plannedAcceptanceTestSchema>[],
  contract: ExecutionContract,
): PlannedAcceptanceTest[] {
  const criteria = new Map(contract.criteria.map((criterion) => [criterion.id, criterion]));
  const usedIds = new Set<string>();
  const normalized: PlannedAcceptanceTest[] = [];
  for (const proposedInput of proposed) {
    const proposedTest = plannedAcceptanceTestSchema.parse(proposedInput);
    let id = safeTestId(proposedTest.id);
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${safeTestId(proposedTest.id)}-${suffix}`;
    usedIds.add(id);
    const criterionIds = [...new Set(proposedTest.criterionIds.filter((criterionId) => criteria.has(criterionId)))];
    normalized.push({
      ...proposedTest,
      id,
      criterionIds,
      verificationPhase: requiresPostReleaseVerification(proposedTest)
        ? "post-release"
        : proposedTest.verificationPhase,
    });
  }

  const covered = new Set(normalized.flatMap((test) => test.criterionIds));
  for (const criterion of contract.criteria) {
    if (covered.has(criterion.id)) continue;
    const manual = criterion.verification === "manual" || criterion.kind === "manual";
    const postRelease = describesPostReleaseObservation(criterion.description);
    let id = safeTestId(`criterion-${criterion.id}`);
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${safeTestId(`criterion-${criterion.id}`)}-${suffix}`;
    usedIds.add(id);
    normalized.push({
      id,
      title: `Verify: ${criterion.description}`.slice(0, 500),
      criterionIds: [criterion.id],
      category: manual ? "manual" : criterion.kind,
      scope: manual ? "manual" : criterion.verification === "protected-test" ? "protected" : "global",
      verificationPhase: postRelease ? "post-release" : "release-gate",
      procedure: manual
        ? `A human reviewer must evaluate this confirmed criterion: ${criterion.description}`
        : postRelease
          ? `Evaluate this outcome only after verified publication: ${criterion.description}`
          : `Inspect the integrated candidate and run the most direct non-destructive check that proves this confirmed criterion: ${criterion.description}`,
      expectedOutcome: criterion.description,
    });
  }

  if (!normalized.some((test) => test.category === "regression")) {
    normalized.push({
      id: "existing-regression-suite",
      title: "Existing regression suite remains healthy",
      criterionIds: [],
      category: "regression",
      scope: "global",
      verificationPhase: "release-gate",
      procedure: "Discover and run the starting workspace's existing automated checks that are relevant and safe in the candidate workspace. If the starting workspace has no automated-check infrastructure, record this regression check as skipped because there is no baseline suite to regress.",
      expectedOutcome: "Existing relevant tests, type checks, builds, and static checks pass; when the starting workspace has none, the check is explicitly skipped as not applicable.",
    });
  }
  return normalized.slice(0, 200);
}
