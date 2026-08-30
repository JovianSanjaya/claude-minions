import { createElement, isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { OrchestrationPanel } from "./OrchestrationPanel";
import type { OrchestrationPanelProps } from "./OrchestrationPanel";
import type { OrchestrationApi } from "./api-port";
import {
  elapsedMsFor,
  evidenceCounters,
  mergeCollections,
  normalizeReadModel,
} from "./view-model";

/**
 * Compile-time contract test (specification 8.13).
 *
 * The React module must build against its injected port before Task 1's routes
 * exist. This file implements `OrchestrationApi` in full with a deterministic
 * in-test adapter and constructs the panel element, so any drift between the
 * port, the props, and the components fails the build rather than the demo.
 *
 * This adapter is a test fake. It is not reachable from application code.
 */

const READ_MODEL_TOP_LEVEL = {
  // Task 1 returns the read model at the top level for GET /api/orchestrations/:id.
  orchestration: {
    id: "orc-1",
    agentId: "agent-1",
    prompt: "Add password reset",
    requestedMode: "orchestrated",
    selectedMode: "multi-worker",
    status: "ready",
    currentIntentDraftId: "draft-1",
    activeContractId: "contract-1",
    estimate: null,
    budget: {
      maxInputTokens: 200_000,
      maxOutputTokens: 60_000,
      maxEstimatedUsd: null,
      maxModelCalls: 30,
      maxSteps: 40,
      maxWorkerAttempts: 3,
      maxContextExpansionsPerTask: 2,
      maxWallClockMs: 900_000,
    },
    usage: {
      byRole: {},
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedUsd: null,
      pricingStatus: "unknown",
    },
    finalOutput: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    completedAt: null,
  },
  intentDraft: null,
  intentDraftHistory: [],
  // Task 1 names the confirmed contract `activeContract`.
  activeContract: null,
  contractHistory: [],
  pendingAmendment: null,
  amendments: [],
  // Task 1's PlanView: a map version plus task IDs, not an inline map.
  plan: {
    selectedMode: "multi-worker",
    routeReason: "Three independent modules with narrow interfaces",
    applicationMapVersion: 1,
    taskIds: [],
    createdAt: "2026-01-01T00:00:06.000Z",
  },
  applicationMaps: [
    {
      orchestrationId: "orc-1",
      version: 1,
      repositoryHash: "0123456789abcdef",
      summary: "server, web, docs",
      fileCount: 42,
      createdAt: "2026-01-01T00:00:05.000Z",
    },
  ],
  tasks: [],
  events: [],
  artifacts: [],
  attempts: [],
  verifications: [],
  contextPackets: [],
  workspaceDispositions: [],
  usage: {
    byRole: {},
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedUsd: null,
    pricingStatus: "unknown",
  },
  budget: {
    policy: {
      maxInputTokens: 200_000,
      maxOutputTokens: 60_000,
      maxEstimatedUsd: null,
      maxModelCalls: 30,
      maxSteps: 40,
      maxWorkerAttempts: 3,
      maxContextExpansionsPerTask: 2,
      maxWallClockMs: 900_000,
    },
    modelCalls: 2,
    steps: 3,
    workerAttempts: 1,
    contextExpansions: 1,
    openReservations: 0,
    wallClockStartedAt: "2026-01-01T00:00:00.000Z",
    elapsedMs: 12_000,
    exhaustedReason: null,
  },
};

class InTestOrchestrationApi implements OrchestrationApi {
  readonly calls: string[] = [];

  private record<T>(name: string, value: T): Promise<T> {
    this.calls.push(name);
    return Promise.resolve(value);
  }

  createOrchestration(agentId: string) {
    return this.record("createOrchestration:" + agentId, { orchestrationId: "orc-1" });
  }

  listOrchestrations(agentId: string) {
    return this.record("listOrchestrations:" + agentId, { orchestrations: [] });
  }

  getOrchestration(orchestrationId: string) {
    return this.record("getOrchestration:" + orchestrationId, READ_MODEL_TOP_LEVEL);
  }

  reviseIntent(orchestrationId: string) {
    return this.record("reviseIntent:" + orchestrationId, {});
  }

  confirmIntent(orchestrationId: string) {
    return this.record("confirmIntent:" + orchestrationId, {});
  }

  startOrchestration(orchestrationId: string) {
    return this.record("startOrchestration:" + orchestrationId, {});
  }

  cancelOrchestration(orchestrationId: string) {
    return this.record("cancelOrchestration:" + orchestrationId, {});
  }

  confirmAmendment(orchestrationId: string, amendmentId: string) {
    return this.record("confirmAmendment:" + orchestrationId + ":" + amendmentId, {});
  }

  rejectAmendment(orchestrationId: string, amendmentId: string) {
    return this.record("rejectAmendment:" + orchestrationId + ":" + amendmentId, {});
  }

  createBenchmark(agentId: string) {
    return this.record("createBenchmark:" + agentId, { benchmark: { id: "bench-1" } });
  }

  getBenchmark(benchmarkId: string) {
    return this.record("getBenchmark:" + benchmarkId, { benchmark: { id: benchmarkId } });
  }

  cancelBenchmark(benchmarkId: string) {
    return this.record("cancelBenchmark:" + benchmarkId, {});
  }

  /** The optional narrow reads Task 1 also exposes. */
  listEvents(orchestrationId: string) {
    return this.record("listEvents:" + orchestrationId, { events: [] });
  }

  listTasks(orchestrationId: string) {
    return this.record("listTasks:" + orchestrationId, { tasks: [] });
  }

  listArtifacts(orchestrationId: string) {
    return this.record("listArtifacts:" + orchestrationId, { artifacts: [] });
  }

  listVerifications(orchestrationId: string) {
    return this.record("listVerifications:" + orchestrationId, { verifications: [] });
  }
}

describe("OrchestrationPanel contract", () => {
  it("accepts a full OrchestrationApi implementation and the documented props", () => {
    const api = new InTestOrchestrationApi();
    const props: OrchestrationPanelProps = {
      agentId: "agent-1",
      agentStatus: "ready",
      agentName: "Frontend Builder",
      api,
      onDirectSend: async () => undefined,
      system: { runtime: "Codex CLI in docker Runtime", arkModel: "ep-demo" },
      initialOrchestrationId: null,
      onTerminalState: () => undefined,
    };
    const element = createElement(OrchestrationPanel, props);
    expect(isValidElement(element)).toBe(true);
  });

  it("accepts the minimum viable props", () => {
    const minimal: OrchestrationPanelProps = {
      agentId: "agent-1",
      agentStatus: "stopped",
      api: new InTestOrchestrationApi(),
    };
    expect(isValidElement(createElement(OrchestrationPanel, minimal))).toBe(true);
  });

  it("reads Task 1's top-level read-model response shape", async () => {
    const api = new InTestOrchestrationApi();
    const view = normalizeReadModel(await api.getOrchestration("orc-1"));
    expect(view?.orchestration.status).toBe("ready");
    expect(view?.plan?.selectedMode).toBe("multi-worker");
    // The plan's map version is resolved against the `applicationMaps` list.
    expect(view?.plan?.applicationMapVersion).toBe(1);
    expect(view?.plan?.applicationMap?.fileCount).toBe(42);
    // Task 1's `budget` ledger view becomes the trusted counters.
    expect(view?.budgetStatus?.modelCalls).toBe(2);
    expect(view?.budgetStatus?.contextExpansions).toBe(1);
    expect(view?.budgetStatus?.exhaustedReason).toBeNull();
    expect(api.calls).toEqual(["getOrchestration:orc-1"]);
  });

  it("prefers the trusted ledger counters and the server's elapsed time", async () => {
    const api = new InTestOrchestrationApi();
    const view = normalizeReadModel(await api.getOrchestration("orc-1"))!;
    expect(evidenceCounters(view).contextExpansions).toBe(1);
    expect(elapsedMsFor(view, 0)).toBe(12_000);
  });

  it("also reads a wrapped read-model response, so either envelope works", () => {
    const wrapped = normalizeReadModel({ readModel: READ_MODEL_TOP_LEVEL });
    expect(wrapped?.orchestration.id).toBe("orc-1");
  });

  it("folds Task 1's wrapped collection responses into a view", async () => {
    const api = new InTestOrchestrationApi();
    const view = normalizeReadModel(await api.getOrchestration("orc-1"))!;
    const merged = mergeCollections(view, {
      events: await api.listEvents("orc-1"),
      tasks: {
        tasks: [{ id: "t1", title: "Persistence", status: "passed" }],
      },
    });
    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0]?.status).toBe("passed");
    expect(merged.events).toEqual([]);
    // Untouched collections are preserved by reference semantics.
    expect(merged.verifications).toBe(view.verifications);
  });
});
