import { z } from "zod";
import type {
  ExecutionContract,
  OrchestrationSink,
  OrchestrationTask,
} from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";
import { ContextBroker, type ContextPacket } from "./context-broker.js";
import { RoleExecutor } from "./role-executor.js";

export const workerPreflightSchema = z
  .object({
    understanding: z.string().min(1).max(2_000),
    expectedFiles: z.array(z.string().min(1).max(300)).max(50),
    interfacesToConsume: z.array(z.string().max(500)).max(50),
    artifactsToPublish: z.array(z.string().max(500)).max(50),
    approach: z.array(z.string().min(1).max(1_000)).min(1).max(20),
    missingContext: z
      .array(
        z.object({ path: z.string().min(1).max(300), reason: z.string().min(1).max(1_000) }).strict(),
      )
      .max(5),
    plannedChecks: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
export type WorkerPreflight = z.infer<typeof workerPreflightSchema>;

const plannerReviewSchema = z
  .object({
    decision: z.enum(["approve", "reject", "expand"]),
    reason: z.string().min(1).max(2_000),
    expansionPath: z.string().min(1).max(300).nullable(),
  })
  .strict();

export interface ApprovedPreflight {
  approved: true;
  preflight: WorkerPreflight;
  context: ContextPacket;
}

export interface RejectedPreflight {
  approved: false;
  preflight: WorkerPreflight;
  reason: string;
}

export type PreflightResult = ApprovedPreflight | RejectedPreflight;

function contextPrompt(packet: ContextPacket): string {
  return [
    "Application map:",
    packet.applicationSummary,
    "Task:",
    packet.taskObjective,
    "Allowed paths:",
    packet.allowedPaths.join("\n"),
    "Acceptance contract excerpt:",
    packet.contractExcerpt.join("\n"),
    "Source files (read-only):",
    ...packet.sources.map((source) => `--- ${source.path} (${source.sha256}) ---\n${source.content}`),
  ].join("\n\n");
}

export class PreflightService {
  constructor(
    private readonly roles: RoleExecutor,
    private readonly broker: ContextBroker,
  ) {}

  async run(input: {
    orchestrationId: string;
    agentId: string;
    task: OrchestrationTask;
    contract: ExecutionContract;
    map: ApplicationMap;
    context: ContextPacket;
    workspacePath: string;
    maxContextExpansions: number;
    sink: OrchestrationSink;
    signal: AbortSignal;
  }): Promise<PreflightResult> {
    let context = input.context;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const workerResult = await this.roles.callStructured(
        {
          orchestrationId: input.orchestrationId,
          taskId: input.task.id,
          agentId: input.agentId,
          role: "worker",
          prompt: [
            "Perform a read-only preflight. Do not edit files or run mutating commands.",
            "Return concise JSON with your understanding, expected files, interfaces, artifacts, approach, narrow missing-context requests, and planned checks.",
            contextPrompt(context),
          ].join("\n\n"),
          workspacePath: input.workspacePath,
          sandboxMode: "read-only",
          estimatedInputTokens: context.summary.estimatedTokens + 1_000,
          estimatedOutputTokens: 1_200,
          sink: input.sink,
          signal: input.signal,
        },
        workerPreflightSchema,
        "{understanding:string, expectedFiles:string[], interfacesToConsume:string[], artifactsToPublish:string[], approach:string[], missingContext:{path:string,reason:string}[], plannedChecks:string[]}",
      );
      const preflight = workerResult.value;
      const review = await this.roles.callStructured(
        {
          orchestrationId: input.orchestrationId,
          taskId: input.task.id,
          agentId: input.agentId,
          role: "planner",
          prompt: [
            "Review this worker preflight against the confirmed contract, path scope, dependencies, and budget.",
            "Approve only if writable execution is safe. Otherwise reject or grant one narrow context expansion.",
            `Task: ${input.task.objective}`,
            `Allowed paths: ${input.task.allowedPaths.join(", ")}`,
            `Contract criteria: ${context.contractExcerpt.join(" | ")}`,
            `Preflight: ${JSON.stringify(preflight)}`,
          ].join("\n\n"),
          workspacePath: input.workspacePath,
          sandboxMode: "read-only",
          estimatedInputTokens: 1_500,
          estimatedOutputTokens: 400,
          sink: input.sink,
          signal: input.signal,
        },
        plannerReviewSchema,
        '{decision:"approve"|"reject"|"expand",reason:string,expansionPath:string|null}',
      );
      await input.sink.recordEvent({
        orchestrationId: input.orchestrationId,
        taskId: input.task.id,
        executionId: review.executionId,
        type: `preflight.${review.value.decision}`,
        actorRole: "planner",
        modelId: review.modelId,
        summary: review.value.reason,
        metadata: { expectedFileCount: preflight.expectedFiles.length },
      });
      if (review.value.decision === "approve") {
        return { approved: true, preflight, context };
      }
      if (review.value.decision === "reject" || cycle === 1) {
        return { approved: false, preflight, reason: review.value.reason };
      }
      const requested =
        review.value.expansionPath ?? preflight.missingContext.at(0)?.path ?? null;
      if (!requested) {
        return { approved: false, preflight, reason: "Planner requested expansion without a path" };
      }
      const expansion = await this.broker.requestExpansion({
        orchestrationId: input.orchestrationId,
        task: input.task,
        map: input.map,
        requestedPath: requested,
        reason: review.value.reason,
        maxExpansions: input.maxContextExpansions,
        sink: input.sink,
      });
      if (!expansion.allowed) return { approved: false, preflight, reason: expansion.reason };
      if (!context.sources.some((source) => source.path === expansion.source.path)) {
        context = {
          ...context,
          sources: [...context.sources, expansion.source],
          summary: {
            ...context.summary,
            sourceFiles: [
              ...context.summary.sourceFiles,
              {
                path: expansion.source.path,
                sha256: expansion.source.sha256,
                bytes: expansion.source.bytes,
              },
            ],
            estimatedTokens:
              context.summary.estimatedTokens + Math.ceil(expansion.source.bytes / 4),
          },
        };
        await input.sink.recordContextPacket(context.summary);
      }
    }
    throw new Error("Preflight cycle invariant violated");
  }
}
