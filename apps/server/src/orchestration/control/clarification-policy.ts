import { randomUUID } from "node:crypto";
import type { ClarificationQuestion, IntentClaim } from "../contracts.js";

export interface ClarificationPolicyConfig {
  /**
   * Safety net only: keywords in a question's prompt/consequence that force
   * materiality to "material" regardless of what the driver claimed. Defends
   * against a driver that under-reports the stakes of a genuinely
   * consequential ambiguity (destructive actions, public interfaces,
   * security, cost). This is intentionally simple keyword matching, not a
   * claim of semantic understanding — the driver's own judgment remains the
   * primary signal; this only ever escalates, never downgrades.
   */
  escalateKeywords: string[];
}

export const DEFAULT_CLARIFICATION_POLICY: ClarificationPolicyConfig = {
  escalateKeywords: [
    "destructive",
    "delete",
    "drop table",
    "irreversible",
    "migration",
    "public api",
    "breaking change",
    "security",
    "auth",
    "password",
    "payment",
    "pii",
    "production",
  ],
};

export interface AutoResolvedQuestion {
  question: ClarificationQuestion;
  claim: IntentClaim;
}

export interface ClarificationPolicyResult {
  /** Questions the control plane will actually surface to the user; these block confirmation. */
  open: ClarificationQuestion[];
  /** Questions resolved autonomously because they were judged inconsequential; never block confirmation. */
  autoResolved: AutoResolvedQuestion[];
}

function isEscalated(question: ClarificationQuestion, config: ClarificationPolicyConfig): boolean {
  const haystack = `${question.prompt} ${question.consequenceIfWrong}`.toLowerCase();
  return config.escalateKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

/**
 * The deterministic control policy from the spec: "The control plane, not a
 * raw model response, must determine whether unresolved material questions
 * prevent confirmation." A driver's `materiality` claim on each question is
 * trusted as the primary signal (the control plane has no semantic
 * understanding of task content), but is never taken at face value —
 * material questions always block, trivial ones are auto-resolved and never
 * shown to the user, and a small keyword safety net can escalate a
 * questionable "trivial" classification. This is intentionally simple,
 * bounded, and side-effect-free (pure function) so it is fully testable.
 */
export function applyClarificationPolicy(
  questions: ClarificationQuestion[],
  config: ClarificationPolicyConfig = DEFAULT_CLARIFICATION_POLICY,
): ClarificationPolicyResult {
  const open: ClarificationQuestion[] = [];
  const autoResolved: AutoResolvedQuestion[] = [];

  for (const question of questions) {
    const effectiveMateriality = isEscalated(question, config) ? "material" : question.materiality;

    if (effectiveMateriality === "material") {
      open.push({ ...question, materiality: "material" });
      continue;
    }

    const chosenOption = question.options.find((option) => option.delegate) ?? question.options[0];
    if (!chosenOption) {
      // No option to auto-resolve with (malformed driver output) — do not
      // silently drop a genuine ambiguity; fail safe by surfacing it.
      open.push({ ...question, materiality: "material" });
      continue;
    }
    autoResolved.push({
      question,
      claim: {
        id: randomUUID(),
        text: chosenOption.resolutionText,
        provenance: "planner-inferred",
        materiality: "trivial",
        rationale: `Auto-resolved without interrupting the user: "${question.prompt}" was judged inconsequential.`,
        supersedes: question.relatedClaimIds[0] ?? null,
      },
    });
  }

  return { open, autoResolved };
}
