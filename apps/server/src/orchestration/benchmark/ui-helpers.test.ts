import { describe, expect, it } from "vitest";
import { canConfirmIntent, filterEvents, isTerminal, safeReadModel } from "../../../../web/src/orchestration/view-model.js";
import { retryDelay } from "../../../../web/src/orchestration/polling.js";
import type { OrchestrationReadModel } from "../../../../web/src/orchestration/contracts.js";

describe("orchestration UI helpers", () => {
  it("maps terminal states and bounded retry backoff", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(retryDelay(20)).toBe(8_000);
  });

  it("requires material questions to be resolved before confirmation", () => {
    const view = { orchestration: { status: "awaiting-confirmation" }, activeDraft: { materialQuestions: ["Which API?"] } } as OrchestrationReadModel;
    expect(canConfirmIntent(view)).toBe(false);
    view.activeDraft!.materialQuestions = [];
    expect(canConfirmIntent(view)).toBe(true);
  });

  it("filters safe correlated events without retaining unknown secret fields", () => {
    const event = { id: "e", taskId: "t", executionId: null, type: "verification-failed", actorRole: "verifier", modelId: "m", summary: "Check failed", metadata: {}, createdAt: "2026-01-01T00:00:00Z", protectedSource: "never" };
    const view = { events: [event], contextPackets: [], orchestration: {}, activeDraft: null } as unknown as OrchestrationReadModel;
    const safe = safeReadModel(view);
    expect(filterEvents(safe.events, "failure", "t")).toHaveLength(1);
    expect(safe.events[0]).not.toHaveProperty("protectedSource");
  });
});
