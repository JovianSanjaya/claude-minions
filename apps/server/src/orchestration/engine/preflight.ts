import { z } from "zod";
import type { ExecutionContract, OrchestrationTask } from "../contracts.js";

export const workerPreflightSchema = z.object({
  understanding: z.string().min(1).max(4_000),
  expectedFiles: z.array(z.string().min(1).max(500)).max(100),
  consumedArtifacts: z.array(z.string().max(500)).max(100),
  publishedArtifacts: z.array(z.string().max(500)).max(100),
  approach: z.array(z.string().min(1).max(2_000)).min(1).max(30),
  missingContext: z.array(z.object({
    path: z.string().min(1).max(500),
    reason: z.string().min(1).max(2_000),
  })).max(20),
  plannedChecks: z.array(z.string().min(1).max(1_000)).min(1).max(30),
}).strict();

export type WorkerPreflight = z.infer<typeof workerPreflightSchema>;

export interface PreflightDecision {
  approved: boolean;
  reason: string;
  expansionPaths: string[];
}

export function reviewPreflight(
  preflight: WorkerPreflight,
  task: OrchestrationTask,
  contract: ExecutionContract,
  availableContextPaths?: readonly string[],
): PreflightDecision {
  const allowed = task.allowedPaths.map((entry) => entry.replaceAll("\\", "/").replace(/\/$/, ""));
  const outside = preflight.expectedFiles.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return !allowed.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  });
  if (outside.length) {
    return {
      approved: false,
      reason: `Preflight would edit paths outside task scope: ${outside.slice(0, 5).join(", ")}`,
      expansionPaths: [],
    };
  }
  const available = availableContextPaths ? new Set(availableContextPaths) : null;
  const invalidContext = preflight.missingContext
    .map((request) => request.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((requested) =>
      !requested ||
      requested === "." ||
      requested.startsWith("/") ||
      /^[A-Za-z]:\//.test(requested) ||
      requested.split("/").includes("..") ||
      (available !== null && !available.has(requested)),
    );
  if (invalidContext.length) {
    return {
      approved: false,
      reason: `Preflight requested invalid or unavailable context paths: ${invalidContext.slice(0, 5).join(", ")}`,
      expansionPaths: [],
    };
  }
  const contractIds = new Set(contract.criteria.map((criterion) => criterion.id));
  const unknownCriteria = task.acceptanceCriterionIds.filter((id) => !contractIds.has(id));
  if (unknownCriteria.length) {
    return {
      approved: false,
      reason: `Task references unknown contract criteria: ${unknownCriteria.join(", ")}`,
      expansionPaths: [],
    };
  }
  return {
    approved: true,
    reason: preflight.missingContext.length
      ? "Scope is valid; grant only the requested narrow context"
      : "Preflight matches the confirmed contract and task scope",
    expansionPaths: preflight.missingContext.map((request) =>
      request.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""),
    ),
  };
}
