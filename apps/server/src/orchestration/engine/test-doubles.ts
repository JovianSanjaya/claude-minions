import { randomUUID } from "node:crypto";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import {
  DEFAULT_BUDGET_POLICY,
  commitModelUsage,
  createEmptyUsageLedger,
  reserveModelCall,
} from "../control/budget-ledger.js";
import type {
  ApplicationMapSummary,
  BudgetPolicy,
  ContextPacketSummary,
  ModelCallReservation,
  ModelRole,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  UsageLedger,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";

/**
 * Reusable fakes for Task 2's own tests, per spec section 4.4: "Task 2
 * tests the engine with an in-memory fake `OrchestrationSink` and fake
 * `AgentRunner`." Not imported by any production code path (driver.ts, the
 * routes, or Final Assembly never reference this file) — it exists solely
 * to keep every engine test file from re-implementing the same doubles.
 *
 * The in-memory sink's budget enforcement is not reimplemented here: it
 * calls Task 1's own `reserveModelCall`/`commitModelUsage` pure functions
 * from control/budget-ledger.ts, so a denial in these tests reflects the
 * same logic Task 1's real control plane uses, not a separate approximation.
 */

export interface InMemorySink extends OrchestrationSink {
  events: OrchestrationEvent[];
  tasks: OrchestrationTask[];
  applicationMaps: ApplicationMapSummary[];
  contextPackets: ContextPacketSummary[];
  attempts: WorkerAttempt[];
  artifacts: SharedArtifact[];
  verifications: VerificationRecord[];
  getUsage(): UsageLedger;
}

export function createInMemorySink(budget: BudgetPolicy = DEFAULT_BUDGET_POLICY): InMemorySink {
  let usage = createEmptyUsageLedger();
  const pendingReservations = new Map<string, { role: ModelRole; modelId: string }>();
  const events: OrchestrationEvent[] = [];
  const tasks: OrchestrationTask[] = [];
  const applicationMaps: ApplicationMapSummary[] = [];
  const contextPackets: ContextPacketSummary[] = [];
  const attempts: WorkerAttempt[] = [];
  const artifacts: SharedArtifact[] = [];
  const verifications: VerificationRecord[] = [];

  return {
    events,
    tasks,
    applicationMaps,
    contextPackets,
    attempts,
    artifacts,
    verifications,
    getUsage: () => usage,
    async reserveModelCall(input: ModelCallReservation) {
      const decision = reserveModelCall(usage, budget, input);
      if (decision.allowed) {
        pendingReservations.set(decision.reservationId, { role: input.role, modelId: input.modelId });
      }
      return decision;
    },
    async commitModelUsage(reservationId: string, actual: TokenUsage) {
      const pending = pendingReservations.get(reservationId);
      if (!pending) return;
      pendingReservations.delete(reservationId);
      usage = commitModelUsage(usage, pending.role, pending.modelId, actual);
    },
    async recordEvent(event) {
      events.push({ ...event, id: randomUUID(), createdAt: new Date().toISOString() });
    },
    async upsertTask(task) {
      const index = tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) tasks[index] = task;
      else tasks.push(task);
    },
    async recordApplicationMap(map) {
      applicationMaps.push(map);
    },
    async recordContextPacket(packet) {
      contextPackets.push(packet);
    },
    async recordAttempt(attempt) {
      const index = attempts.findIndex((item) => item.id === attempt.id);
      if (index >= 0) attempts[index] = attempt;
      else attempts.push(attempt);
    },
    async publishArtifact(artifact) {
      artifacts.push(artifact);
    },
    async recordVerification(record) {
      verifications.push(record);
    },
  };
}

export type FakeRunHandler = (request: RunnerRequest) => Promise<RunnerResult> | RunnerResult;

export function createFakeAgentRunner(handler: FakeRunHandler): AgentRunner {
  return {
    async run(request) {
      return handler(request);
    },
    async cancel() {
      return true;
    },
    async isAvailable() {
      return true;
    },
  };
}

export function usageResult(overrides: Partial<RunnerResult["usage"]> = {}): RunnerResult["usage"] {
  return { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, ...overrides };
}
