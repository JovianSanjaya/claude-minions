import { z } from "zod";
import type { ExecutionContract, OrchestrationTask } from "../contracts.js";
import { callRoleStructured, type RoleExecutorDeps } from "./role-executor.js";
import { isPathWithinAllowed } from "./worker-workspaces.js";

export const preflightPlanSchema = z.object({
  understanding: z.string().trim().min(1),
  filesExpectedToChange: z.array(z.string()).default([]),
  approach: z.string().trim().min(1),
  missingContextRequests: z.array(z.string()).default([]),
  plannedChecks: z.array(z.string()).default([]),
});
export type PreflightPlan = z.infer<typeof preflightPlanSchema>;

export interface PreflightReview {
  approved: boolean;
  reason: string;
}

/**
 * The planner's review of a worker's read-only preflight, checked against
 * the task's scope. No writable execution may precede approval. This is a
 * deterministic scope check (files the worker says it will touch must fall
 * under the task's allowed paths); a fuller build might also have the
 * planner role re-check the plan against contract criteria via a model
 * call, but the scope check alone is enough to demonstrate — and enforce —
 * "no worker edit may precede approval."
 */
export function reviewPreflight(plan: PreflightPlan, task: OrchestrationTask): PreflightReview {
  const outOfScope = plan.filesExpectedToChange.filter(
    (file) => !isPathWithinAllowed(file, task.allowedPaths),
  );
  if (task.allowedPaths.length > 0 && outOfScope.length > 0) {
    return {
      approved: false,
      reason: `Planned changes fall outside the task's allowed paths (${task.allowedPaths.join(", ")}): ${outOfScope.join(", ")}`,
    };
  }
  return { approved: true, reason: "Preflight matches task scope" };
}

function buildPreflightPrompt(task: OrchestrationTask, contract: ExecutionContract, contextSummary: string): string {
  const relevantCriteria = contract.criteria
    .filter((criterion) => task.acceptanceCriterionIds.includes(criterion.id))
    .map((criterion) => `- (${criterion.kind}) ${criterion.description}`)
    .join("\n");
  return [
    `You are preparing to work on task "${task.title}" as a READ-ONLY planning step. Do not edit any files yet.`,
    `Objective: ${task.objective}`,
    `Allowed paths: ${task.allowedPaths.join(", ") || "(no restriction specified)"}`,
    `Relevant acceptance criteria:\n${relevantCriteria || "(none listed)"}`,
    `Context available: ${contextSummary}`,
    "",
    "Respond with ONLY JSON matching this shape:",
    '{"understanding": string, "filesExpectedToChange": string[], "approach": string, "missingContextRequests": string[], "plannedChecks": string[]}',
  ].join("\n");
}

export async function runPreflight(
  deps: RoleExecutorDeps,
  input: {
    agentId: string;
    orchestrationId: string;
    task: OrchestrationTask;
    contract: ExecutionContract;
    contextSummary: string;
    workspacePath: string;
    signal: AbortSignal;
  },
): Promise<{ plan: PreflightPlan; review: PreflightReview }> {
  const prompt = buildPreflightPrompt(input.task, input.contract, input.contextSummary);
  const { value: plan } = await callRoleStructured(
    deps,
    {
      agentId: input.agentId,
      orchestrationId: input.orchestrationId,
      taskId: input.task.id,
      role: "worker",
      prompt,
      workspacePath: input.workspacePath,
      threadId: null,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 300,
      signal: input.signal,
      sandboxMode: "read-only",
    },
    preflightPlanSchema,
  );
  return { plan, review: reviewPreflight(plan, input.task) };
}
