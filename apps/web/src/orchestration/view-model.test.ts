import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET,
  budgetGauges,
  budgetStopReason,
  compareEstimateToActual,
  confirmationGate,
  elapsedMsFor,
  evidenceCounters,
  eventMatchesFilter,
  extractBenchmarkId,
  extractOrchestrationId,
  filterEvents,
  formatEstimatedUsd,
  isForbiddenField,
  modeToAction,
  normalizeBenchmark,
  normalizeReadModel,
  normalizeSummaryList,
  orchestrationStatusPresentation,
  presentBenchmark,
  safePath,
  safeText,
  summarizeUsage,
  taskStatusPresentation,
} from "./view-model";
import type { OrchestrationReadModel } from "./contracts";

function readModel(overrides: Record<string, unknown> = {}): unknown {
  return {
    orchestration: {
      id: "orc-1",
      agentId: "agent-1",
      prompt: "Add password reset",
      requestedMode: "orchestrated",
      selectedMode: "multi-worker",
      status: "awaiting-confirmation",
      currentIntentDraftId: "draft-1",
      activeContractId: null,
      estimate: {
        inputTokenLow: 1_000,
        inputTokenHigh: 4_000,
        outputTokenLow: 200,
        outputTokenHigh: 900,
        estimatedUsdLow: 0.01,
        estimatedUsdHigh: 0.09,
        pricingStatus: "configured",
        assumptions: ["Repository fits in one application map"],
      },
      budget: { ...DEFAULT_BUDGET, maxInputTokens: 10_000, maxModelCalls: 20 },
      usage: {
        byRole: {
          planner: {
            modelId: "ep-planner",
            inputTokens: 900,
            cachedInputTokens: 100,
            outputTokens: 300,
            estimatedUsd: 0.02,
            modelCalls: 2,
          },
        },
        totalInputTokens: 900,
        totalCachedInputTokens: 100,
        totalOutputTokens: 300,
        totalEstimatedUsd: 0.02,
        pricingStatus: "configured",
      },
      finalOutput: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: null,
    },
    intentDraft: {
      id: "draft-1",
      orchestrationId: "orc-1",
      revision: 2,
      goal: "Add a password reset flow",
      requirements: ["Tokens expire in one hour"],
      assumptions: ["Email delivery already exists"],
      nonGoals: ["No SSO"],
      architectureDecisions: ["Reuse the existing user table"],
      materialQuestions: ["Should tokens be single use?"],
      manualExpectations: ["The email copy reads naturally"],
      createdAt: "2026-01-01T00:00:30.000Z",
    },
    ...overrides,
  };
}

describe("read model normalization", () => {
  it("narrows a well-formed payload", () => {
    const view = normalizeReadModel(readModel());
    expect(view).not.toBeNull();
    expect(view?.orchestration.status).toBe("awaiting-confirmation");
    expect(view?.intentDraft?.revision).toBe(2);
    expect(view?.tasks).toEqual([]);
    expect(view?.events).toEqual([]);
  });

  it("accepts unknown extra fields and unknown enum values without throwing", () => {
    const view = normalizeReadModel(
      readModel({
        orchestration: {
          id: "orc-2",
          status: "a-status-from-the-future",
          requestedMode: "telepathy",
          selectedMode: "quantum",
          somethingNew: { nested: true },
        },
        tasks: [{ id: "t1", status: "warp-speed", allowedPaths: ["/etc/passwd"] }],
      }),
    );
    expect(view?.orchestration.status).toBe("drafting-intent");
    expect(view?.orchestration.requestedMode).toBe("auto");
    expect(view?.orchestration.selectedMode).toBeNull();
    expect(view?.tasks[0]?.status).toBe("blocked");
    // Absolute host paths are shortened before they can be rendered.
    expect(view?.tasks[0]?.allowedPaths[0]).toBe("etc/passwd");
    expect(Object.keys(view ?? {})).not.toContain("somethingNew");
  });

  it("returns null for a payload that is not an orchestration", () => {
    expect(normalizeReadModel(null)).toBeNull();
    expect(normalizeReadModel({ nope: true })).toBeNull();
    expect(normalizeReadModel("string")).toBeNull();
  });

  it("never renders protected, reasoning, or secret fields", () => {
    const view = normalizeReadModel(
      readModel({
        events: [
          {
            id: "e1",
            type: "verification.completed",
            actorRole: "verifier",
            summary: "Protected acceptance passed",
            createdAt: "2026-01-01T00:02:00.000Z",
            metadata: {
              reasoning: "the model privately thought about X",
              protectedSource: "expect(reset).toBeSingleUse()",
              apiKey: "sk-live-abcdefghijklmnop",
              taskId: "t1",
              attempt: 2,
            },
          },
        ],
        verifications: [
          {
            id: "v1",
            scope: "protected",
            commandOrCheck: "protected-acceptance",
            status: "passed",
            outputSummary: "Authorization: Bearer abcdefghijklmnop",
            startedAt: "",
            completedAt: "",
          },
        ],
      }),
    );
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("privately thought");
    expect(serialized).not.toContain("toBeSingleUse");
    expect(serialized).not.toContain("sk-live-abcdefghijklmnop");
    expect(serialized).not.toContain("Bearer abcdefghijklmnop");
    // Safe correlation metadata still survives.
    expect(view?.events[0]?.metadata.taskId).toBe("t1");
    expect(view?.events[0]?.metadata.attempt).toBe(2);
  });

  it("drops a dollar figure whenever pricing is not configured", () => {
    const view = normalizeReadModel(
      readModel({
        orchestration: {
          ...(readModel() as { orchestration: Record<string, unknown> }).orchestration,
          usage: {
            byRole: {},
            totalInputTokens: 5,
            totalCachedInputTokens: 0,
            totalOutputTokens: 5,
            totalEstimatedUsd: 12.5,
            pricingStatus: "unknown",
          },
        },
      }),
    );
    expect(view?.orchestration.usage.totalEstimatedUsd).toBeNull();
    expect(view?.orchestration.usage.pricingStatus).toBe("unknown");
  });

  it("bounds oversized text and hides host paths", () => {
    expect(safeText("y".repeat(9_000)).length).toBeLessThanOrEqual(4_001);
    expect(safePath("/home/runner/work/agent/workspaces/abc/src/index.ts")).toBe(
      "…/abc/src/index.ts",
    );
    expect(isForbiddenField("ARK_API_KEY")).toBe(true);
    expect(isForbiddenField("taskId")).toBe(false);
  });

  it("extracts IDs from either envelope shape", () => {
    expect(extractOrchestrationId({ orchestrationId: "a" })).toBe("a");
    expect(extractOrchestrationId({ orchestration: { id: "b" } })).toBe("b");
    expect(extractOrchestrationId({ id: "c" })).toBe("c");
    expect(extractOrchestrationId({})).toBeNull();
    expect(extractBenchmarkId({ benchmark: { id: "d" } })).toBe("d");
  });

  it("normalizes a summary list", () => {
    const list = normalizeSummaryList({
      orchestrations: [{ id: "o1", status: "running", requestedMode: "auto" }, { nope: 1 }],
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("running");
  });
});

describe("mode and confirmation gating", () => {
  it("maps each mode to exactly one action", () => {
    expect(modeToAction("direct")).toEqual({ kind: "direct" });
    expect(modeToAction("auto")).toEqual({ kind: "orchestration", requestedMode: "auto" });
    expect(modeToAction("orchestrated")).toEqual({
      kind: "orchestration",
      requestedMode: "orchestrated",
    });
  });

  it("blocks confirmation while a material question is unanswered", () => {
    const view = normalizeReadModel(readModel()) as OrchestrationReadModel;
    const blocked = confirmationGate(view, {});
    expect(blocked.canConfirm).toBe(false);
    expect(blocked.unresolvedQuestions).toEqual(["Should tokens be single use?"]);
    expect(blocked.reason).toContain("1 material question");

    const whitespaceOnly = confirmationGate(view, {
      "Should tokens be single use?": "   ",
    });
    expect(whitespaceOnly.canConfirm).toBe(false);

    const answered = confirmationGate(view, {
      "Should tokens be single use?": "Yes, single use.",
    });
    expect(answered.canConfirm).toBe(true);
    expect(answered.reason).toBeNull();
  });

  it("never allows confirmation outside awaiting-confirmation", () => {
    const view = normalizeReadModel(
      readModel({
        orchestration: {
          ...(readModel() as { orchestration: Record<string, unknown> }).orchestration,
          status: "running",
        },
      }),
    ) as OrchestrationReadModel;
    expect(confirmationGate(view, {}).canConfirm).toBe(false);
    expect(confirmationGate(null, {}).canConfirm).toBe(false);
  });
});

describe("event filters and status mapping", () => {
  const view = normalizeReadModel(
    readModel({
      events: [
        {
          id: "e1",
          type: "task.attempt.started",
          actorRole: "worker",
          taskId: "t1",
          summary: "worker started",
          createdAt: "",
          metadata: {},
        },
        {
          id: "e2",
          type: "budget.denied",
          actorRole: "control-plane",
          summary: "reservation denied",
          createdAt: "",
          metadata: {},
        },
        {
          id: "e3",
          type: "verification.protected.completed",
          actorRole: "verifier",
          summary: "protected check passed",
          createdAt: "",
          metadata: {},
        },
        {
          id: "e4",
          type: "integration.conflict",
          actorRole: "integrator",
          summary: "merge conflict",
          createdAt: "",
          metadata: {},
        },
      ],
      tasks: [{ id: "t1", title: "Persistence", status: "running" }],
    }),
  ) as OrchestrationReadModel;

  it("selects only the matching events for each filter", () => {
    expect(filterEvents(view.events, "all")).toHaveLength(4);
    expect(filterEvents(view.events, "budget").map((item) => item.id)).toEqual(["e2"]);
    expect(filterEvents(view.events, "verification").map((item) => item.id)).toEqual([
      "e3",
    ]);
    expect(filterEvents(view.events, "integration").map((item) => item.id)).toEqual([
      "e4",
    ]);
    expect(filterEvents(view.events, "task").map((item) => item.id)).toContain("e1");
    expect(filterEvents(view.events, "failure").map((item) => item.id)).toContain("e2");
  });

  it("narrows to one task", () => {
    expect(filterEvents(view.events, "all", "t1").map((item) => item.id)).toEqual(["e1"]);
    expect(eventMatchesFilter(view.events[1]!, "budget")).toBe(true);
  });

  it("gives every status a text label and an icon, not colour alone", () => {
    for (const status of ["passed", "failed", "stale", "running"] as const) {
      const presentation = taskStatusPresentation(status);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.icon.length).toBeGreaterThan(0);
    }
    expect(orchestrationStatusPresentation("budget-exhausted").label).toBe("Budget stop");
  });
});

describe("usage, budget, and cost", () => {
  it("totals usage by role and labels estimated cost", () => {
    const view = normalizeReadModel(readModel()) as OrchestrationReadModel;
    const summary = summarizeUsage(view.orchestration.usage);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]?.role).toBe("planner");
    expect(summary.totalTokens).toBe(1_200);
    expect(summary.totalModelCalls).toBe(2);
    expect(summary.costLabel).toBe("estimated cost $0.0200");
    expect(summary.costLabel).not.toContain("billed");
  });

  it("says pricing is not configured instead of inventing a number", () => {
    expect(formatEstimatedUsd(null)).toBe("Pricing not configured");
    const summary = summarizeUsage({
      byRole: {
        worker: {
          modelId: "ep-worker",
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          estimatedUsd: 4.2,
          modelCalls: 1,
        },
      },
      totalInputTokens: 10,
      totalCachedInputTokens: 0,
      totalOutputTokens: 5,
      totalEstimatedUsd: 4.2,
      pricingStatus: "unknown",
    });
    expect(summary.totalEstimatedUsd).toBeNull();
    expect(summary.rows[0]?.estimatedUsd).toBeNull();
    expect(summary.costLabel).toBe("Pricing not configured");
  });

  it("computes budget gauges and flags a reached hard limit", () => {
    const view = normalizeReadModel(readModel()) as OrchestrationReadModel;
    const gauges = budgetGauges(view.orchestration.usage, view.orchestration.budget, 2, 5_000);
    const input = gauges.find((gauge) => gauge.label === "Input tokens");
    expect(input?.ratio).toBeCloseTo(0.09, 5);
    expect(input?.exceeded).toBe(false);

    const exhausted = budgetGauges(
      { ...view.orchestration.usage, totalInputTokens: 10_000 },
      view.orchestration.budget,
      20,
      0,
    );
    expect(exhausted.find((gauge) => gauge.label === "Input tokens")?.exceeded).toBe(true);
    expect(exhausted.find((gauge) => gauge.label === "Model calls")?.exceeded).toBe(true);
  });

  it("compares the pre-execution estimate to actual usage", () => {
    const view = normalizeReadModel(readModel()) as OrchestrationReadModel;
    const comparison = compareEstimateToActual(
      view.orchestration.estimate,
      view.orchestration.usage,
    );
    expect(comparison?.tokenRange).toBe("1,200 – 4,900 tokens");
    expect(comparison?.actualTokens).toBe(1_200);
    expect(comparison?.overHighEstimate).toBe(false);
    expect(compareEstimateToActual(null, view.orchestration.usage)).toBeNull();
  });

  it("reports the control plane's exact budget-stop reason", () => {
    const withLedger = normalizeReadModel({
      ...(readModel() as Record<string, unknown>),
      budget: {
        policy: DEFAULT_BUDGET,
        modelCalls: 30,
        steps: 30,
        workerAttempts: 3,
        contextExpansions: 2,
        openReservations: 0,
        wallClockStartedAt: "2026-01-01T00:00:00.000Z",
        elapsedMs: 42_000,
        exhaustedReason: "maxModelCalls reached (30)",
      },
    }) as OrchestrationReadModel;
    expect(budgetStopReason(withLedger)).toBe("maxModelCalls reached (30)");
    expect(elapsedMsFor(withLedger, 0)).toBe(42_000);
    expect(evidenceCounters(withLedger).contextExpansions).toBe(2);

    // Without a ledger, a non-exhausted orchestration reports no stop reason.
    const plain = normalizeReadModel(readModel()) as OrchestrationReadModel;
    expect(budgetStopReason(plain)).toBeNull();
  });

  it("counts evidence from safe event types", () => {
    const view = normalizeReadModel(
      readModel({
        events: [
          { id: "e1", type: "context.expansion.granted", summary: "", createdAt: "" },
          { id: "e2", type: "escalation.created", summary: "", createdAt: "" },
          { id: "e3", type: "integration.failed", summary: "", createdAt: "" },
          { id: "e4", type: "artifact.stale", summary: "", createdAt: "" },
        ],
      }),
    ) as OrchestrationReadModel;
    const counters = evidenceCounters(view);
    expect(counters.contextExpansions).toBe(1);
    expect(counters.escalations).toBe(1);
    expect(counters.integrationFailures).toBe(1);
    expect(counters.staleRefreshes).toBe(1);
  });
});

describe("benchmark presentation", () => {
  const baseArm = {
    status: "succeeded",
    executionId: "exec",
    selectedMode: "direct",
    startedFromSnapshotHash: "abc123def456789",
    workspaceLabel: "benchmark-1/arm-direct",
    verifications: [
      { scope: "global", commandOrCheck: "npm run check", status: "passed", outputSummary: "ok" },
    ],
    succeeded: true,
    usage: {
      byRole: {},
      totalInputTokens: 100,
      totalCachedInputTokens: 0,
      totalOutputTokens: 20,
      totalEstimatedUsd: 0.1,
      pricingStatus: "configured",
    },
    counters: {
      modelCalls: 1,
      attempts: 1,
      contextExpansions: 0,
      escalations: 0,
      integrationFailures: 0,
    },
    wallClockMs: 1_000,
    finalOutputSummary: "done",
    error: null,
    startedAt: null,
    completedAt: null,
  };

  it("presents quality before cost and withholds a cost claim when quality differs", () => {
    const record = normalizeBenchmark({
      benchmark: {
        id: "b1",
        agentId: "a1",
        prompt: "task",
        status: "completed",
        sourceSnapshotHash: "abc123def456789",
        armOrder: ["direct", "orchestrated"],
        arms: {
          direct: baseArm,
          orchestrated: { ...baseArm, status: "failed", succeeded: false },
        },
        comparison: {
          qualityVerdict: "direct-only",
          verificationComparable: true,
          costComparable: false,
          tokenVerdict: "not-comparable",
          costVerdict: "not-comparable",
          wallClockVerdict: "tie",
          totalTokenDelta: null,
          estimatedUsdDelta: null,
          wallClockDeltaMs: 0,
          pricingStatus: "configured",
          warnings: ["Cost comparison withheld"],
          limitations: ["One sample per arm"],
        },
      },
    });
    expect(record).not.toBeNull();
    const presentation = presentBenchmark(record!);
    expect(presentation.qualityHeadline).toContain("Only the direct arm passed");
    expect(presentation.costWithheld).toBe(true);
    expect(presentation.costHeadline).toContain("withheld");
    expect(presentation.snapshotLine).toContain("abc123def456");
    expect(presentation.arms[0]?.qualityLine).toContain("Passed every trusted check");
    expect(presentation.arms[1]?.qualityLine).toContain("No verified pass");
  });

  it("reports token totals with unknown pricing", () => {
    const record = normalizeBenchmark({
      benchmark: {
        id: "b2",
        status: "completed",
        arms: { direct: baseArm, orchestrated: baseArm },
        comparison: {
          qualityVerdict: "both-passed",
          verificationComparable: true,
          costComparable: true,
          tokenVerdict: "orchestrated-better",
          costVerdict: "unknown-pricing",
          wallClockVerdict: "tie",
          totalTokenDelta: -400,
          estimatedUsdDelta: 9.9,
          wallClockDeltaMs: 0,
          pricingStatus: "unknown",
          warnings: [],
          limitations: [],
        },
      },
    });
    // A dollar delta is dropped whenever pricing is unknown.
    expect(record?.comparison?.estimatedUsdDelta).toBeNull();
    const presentation = presentBenchmark(record!);
    expect(presentation.costHeadline).toContain("Pricing not configured");
    expect(presentation.costHeadline).toContain("-400");
  });

  it("returns null for a payload without an ID", () => {
    expect(normalizeBenchmark({ benchmark: {} })).toBeNull();
    expect(normalizeBenchmark(undefined)).toBeNull();
  });
});
