import { describe, expect, it } from "vitest";
import type {
  BenchmarkRecord,
  IntentClaim,
  IntentDraft,
  Orchestration,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationTask,
  UsageLedger,
  WorkerAttempt,
} from "./contracts";
import {
  budgetTone,
  computeBudgetUsage,
  computeTaskProgress,
  describeStatus,
  describeTaskStatus,
  evaluateConfirmationGate,
  filterEvents,
  formatElapsedMs,
  formatEstimateRange,
  formatOrchestrationHistoryLabel,
  formatUsage,
  groupClaimsByProvenance,
  interpretBenchmarkResult,
  isTerminalStatus,
  modeToRequestedMode,
  safeOrchestration,
  showsRunProgress,
  sortOrchestrationsByRecency,
  taskElapsedLabel,
  toSafeEventView,
} from "./view-model";

function claim(text: string, overrides: Partial<IntentClaim> = {}): IntentClaim {
  return { id: text, text, provenance: "user-explicit", materiality: "trivial", rationale: null, supersedes: null, ...overrides };
}

function draft(overrides: Partial<IntentDraft> = {}): IntentDraft {
  return {
    id: "draft-1",
    orchestrationId: "orch-1",
    revision: 0,
    goal: "Add password reset",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    manualExpectations: [],
    openQuestions: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function orchestration(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id: "orch-1",
    agentId: "agent-1",
    prompt: "Add password reset",
    requestedMode: "auto",
    selectedMode: null,
    status: "awaiting-confirmation",
    currentIntentDraftId: "draft-1",
    activeContractId: null,
    estimate: null,
    budget: {
      maxInputTokens: null,
      maxOutputTokens: null,
      maxEstimatedUsd: null,
      maxModelCalls: 40,
      maxSteps: 40,
      maxWorkerAttempts: 3,
      maxContextExpansionsPerTask: 3,
      maxWallClockMs: 1_200_000,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function readModel(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    orchestration: orchestration(),
    currentDraft: draft(),
    draftHistory: [],
    activeContract: null,
    contractHistory: [],
    amendments: [],
    pendingAmendment: null,
    applicationMap: null,
    tasks: [],
    artifacts: [],
    verifications: [],
    attempts: [],
    events: [],
    ...overrides,
  };
}

describe("modeToRequestedMode", () => {
  it("maps each Playground mode to the correct requestedMode", () => {
    expect(modeToRequestedMode("direct")).toBe("direct");
    expect(modeToRequestedMode("orchestrated")).toBe("orchestrated");
    expect(modeToRequestedMode("auto")).toBe("auto");
  });
});

describe("isTerminalStatus / describeStatus", () => {
  it("classifies terminal vs non-terminal statuses correctly", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("budget-exhausted")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("awaiting-confirmation")).toBe(false);
  });

  it("gives every status a human label and a tone, distinguishable beyond color", () => {
    expect(describeStatus("needs-user").tone).toBe("warning");
    expect(describeStatus("completed").tone).toBe("success");
    expect(describeStatus("failed").tone).toBe("danger");
    expect(describeStatus("completed").label).not.toBe(describeStatus("failed").label);
  });
});

describe("evaluateConfirmationGate", () => {
  it("disables confirmation while material questions remain unresolved", () => {
    const model = readModel({
      currentDraft: draft({
        openQuestions: [
          {
            id: "q1",
            prompt: "1h or 24h?",
            materiality: "material",
            consequenceIfWrong: "x",
            options: [],
            category: "requirements",
            relatedClaimIds: [],
          },
        ],
      }),
    });
    const gate = evaluateConfirmationGate(model);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/material question/i);
  });

  it("allows confirmation once no open questions remain and status is awaiting-confirmation", () => {
    const gate = evaluateConfirmationGate(readModel());
    expect(gate.allowed).toBe(true);
  });

  it("disables confirmation when there is no draft at all", () => {
    const gate = evaluateConfirmationGate(readModel({ currentDraft: null }));
    expect(gate.allowed).toBe(false);
  });

  it("disables confirmation when the orchestration has moved past awaiting-confirmation", () => {
    const gate = evaluateConfirmationGate(readModel({ orchestration: orchestration({ status: "planning" }) }));
    expect(gate.allowed).toBe(false);
  });
});

describe("groupClaimsByProvenance", () => {
  it("keeps a planner-inferred claim visibly distinct from a user-explicit one", () => {
    const groups = groupClaimsByProvenance(
      draft({
        requirements: [claim("explicit req", { provenance: "user-explicit" })],
        architectureDecisions: [claim("inferred decision", { provenance: "planner-inferred" })],
        assumptions: [claim("repo fact", { provenance: "repository-derived" })],
        manualExpectations: [claim("delegated", { provenance: "user-delegated" })],
      }),
    );
    expect(groups.userExplicit.map((c) => c.text)).toEqual(["explicit req"]);
    expect(groups.plannerInferred.map((c) => c.text)).toEqual(["inferred decision"]);
    expect(groups.repositoryDerived.map((c) => c.text)).toEqual(["repo fact"]);
    expect(groups.userDelegated.map((c) => c.text)).toEqual(["delegated"]);
  });
});

describe("formatUsage / formatEstimateRange", () => {
  const baseUsage: UsageLedger = {
    byRole: {},
    totalInputTokens: 1000,
    totalCachedInputTokens: 200,
    totalOutputTokens: 500,
    totalEstimatedUsd: null,
    pricingStatus: "unknown",
  };

  it("shows 'Pricing not configured' rather than a fabricated dollar amount when unknown", () => {
    const display = formatUsage(baseUsage);
    expect(display.costLabel).toBe("Pricing not configured");
    expect(display.pricingConfigured).toBe(false);
    expect(display.tokensLabel).toContain("1,000");
  });

  it("shows an estimated cost, never claiming it is billed, when pricing is configured", () => {
    const display = formatUsage({ ...baseUsage, pricingStatus: "configured", totalEstimatedUsd: 1.2345 });
    expect(display.costLabel).toMatch(/^estimated cost/);
    expect(display.costLabel).not.toMatch(/billed/i);
    expect(display.pricingConfigured).toBe(true);
  });

  it("formats the pre-confirmation estimate range with unknown pricing honestly", () => {
    const o = orchestration({
      estimate: {
        inputTokenLow: 100,
        inputTokenHigh: 500,
        outputTokenLow: 50,
        outputTokenHigh: 200,
        estimatedUsdLow: null,
        estimatedUsdHigh: null,
        pricingStatus: "unknown",
        assumptions: [],
      },
    });
    expect(formatEstimateRange(o)).toMatch(/pricing not configured/i);
  });

  it("reports 'No estimate yet' before elaboration completes", () => {
    expect(formatEstimateRange(orchestration({ estimate: null }))).toBe("No estimate yet");
  });
});

describe("filterEvents", () => {
  const events: OrchestrationEvent[] = [
    { id: "1", orchestrationId: "o", taskId: "t1", executionId: null, type: "planned", actorRole: "planner", modelId: null, summary: "x", metadata: {}, createdAt: "1" },
    { id: "2", orchestrationId: "o", taskId: "t2", executionId: null, type: "cancelled", actorRole: "user", modelId: null, summary: "y", metadata: {}, createdAt: "2" },
  ];

  it("filters by taskId, actorRole, and type independently", () => {
    expect(filterEvents(events, { taskId: "t1" })).toHaveLength(1);
    expect(filterEvents(events, { actorRole: "user" })).toHaveLength(1);
    expect(filterEvents(events, { type: "planned" })).toHaveLength(1);
    expect(filterEvents(events, {})).toHaveLength(2);
  });
});

describe("toSafeEventView: no protected/secret fields ever rendered", () => {
  it("only exposes curated fields, stringifying metadata rather than spreading raw objects", () => {
    const event: OrchestrationEvent = {
      id: "1",
      orchestrationId: "o",
      taskId: null,
      executionId: null,
      type: "budget-denied",
      actorRole: "worker",
      modelId: "ep-1",
      summary: "denied",
      // simulate a rogue field an attacker or bug might smuggle into metadata
      metadata: { apiKey: "sk-should-not-render-as-object", count: 3 },
      createdAt: "now",
    };
    const view = toSafeEventView(event);
    expect(Object.keys(view).sort()).toEqual(["actorRole", "createdAt", "id", "metadataEntries", "summary", "type"]);
    // metadata values are stringified, never rendered as a live object/element
    expect(view.metadataEntries).toEqual([
      ["apiKey", "sk-should-not-render-as-object"],
      ["count", "3"],
    ]);
    expect(view.metadataEntries.every(([, value]) => typeof value === "string")).toBe(true);
  });

  it("never crashes and defaults safely when metadata or summary is missing/malformed", () => {
    const malformed = {
      id: "1",
      orchestrationId: "o",
      taskId: null,
      executionId: null,
      type: "x",
      actorRole: "user",
      modelId: null,
      summary: undefined,
      metadata: undefined,
      createdAt: "now",
    } as unknown as OrchestrationEvent;
    const view = toSafeEventView(malformed);
    expect(view.summary).toBe("");
    expect(view.metadataEntries).toEqual([]);
  });
});

describe("safeOrchestration: safe unknown-field handling", () => {
  it("returns the value when required fields are present", () => {
    expect(safeOrchestration(orchestration())).not.toBeNull();
  });

  it("returns null rather than crashing on missing required fields", () => {
    expect(safeOrchestration({ id: "x" })).toBeNull();
    expect(safeOrchestration(null)).toBeNull();
    expect(safeOrchestration(undefined)).toBeNull();
    expect(safeOrchestration("a string")).toBeNull();
    expect(safeOrchestration(42)).toBeNull();
  });

  it("does not choke on extra unknown fields from a newer server response", () => {
    const withExtra = { ...orchestration(), somethingFromTheFuture: { nested: true } };
    expect(safeOrchestration(withExtra)).not.toBeNull();
  });
});

describe("interpretBenchmarkResult: quality is presented before cost", () => {
  function arm(overrides: Partial<BenchmarkRecord["direct"]> = {}) {
    return {
      mode: "direct" as const,
      modelIds: { worker: "ep-default" },
      success: true,
      verificationSummary: "ok",
      totalInputTokens: 100,
      totalCachedInputTokens: 0,
      totalOutputTokens: 50,
      estimatedUsd: null,
      pricingStatus: "unknown" as const,
      wallClockMs: 100,
      modelCalls: 1,
      attempts: 1,
      contextExpansions: 0,
      escalations: 0,
      integrationFailures: 0,
      error: null,
      ...overrides,
    };
  }
  function benchmark(overrides: Partial<BenchmarkRecord> = {}): BenchmarkRecord {
    return {
      id: "b1",
      agentId: "agent-1",
      workspaceSnapshotHash: "hash",
      prompt: "x",
      criteria: [],
      status: "completed",
      direct: arm(),
      orchestrated: arm({ mode: "orchestrated" }),
      comparabilityWarnings: [],
      createdAt: "now",
      completedAt: "now",
      ...overrides,
    };
  }

  it("never claims a cost winner when only one arm passed verification", () => {
    const result = interpretBenchmarkResult(
      benchmark({ direct: arm({ success: true }), orchestrated: arm({ mode: "orchestrated", success: false }) }),
    );
    expect(result.safeToCompareCost).toBe(false);
    expect(result.verdict).toMatch(/quality, not cost/i);
  });

  it("allows a cost comparison, and allows direct to win, when both pass with configured pricing", () => {
    const result = interpretBenchmarkResult(
      benchmark({
        direct: arm({ success: true, pricingStatus: "configured", estimatedUsd: 0.1 }),
        orchestrated: arm({ mode: "orchestrated", success: true, pricingStatus: "configured", estimatedUsd: 0.5 }),
      }),
    );
    expect(result.safeToCompareCost).toBe(true);
    expect(result.verdict).toMatch(/direct was cheaper/i);
  });

  it("reports incomplete rather than guessing when an arm hasn't finished", () => {
    const result = interpretBenchmarkResult(benchmark({ orchestrated: null, status: "running" }));
    expect(result.safeToCompareCost).toBe(false);
  });
});

function task(overrides: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    id: "task-1",
    orchestrationId: "orch-1",
    title: "Task 1",
    objective: "Do the thing",
    status: "ready",
    dependsOn: [],
    allowedPaths: [],
    acceptanceCriterionIds: [],
    requiredArtifactIds: [],
    observedArtifactVersions: {},
    applicationMapVersion: 1,
    attemptCount: 0,
    ...overrides,
  };
}

function attempt(overrides: Partial<WorkerAttempt> = {}): WorkerAttempt {
  return {
    id: "attempt-1",
    orchestrationId: "orch-1",
    taskId: "task-1",
    number: 1,
    executionId: "exec-1",
    modelId: "ep-worker",
    contextFileHashes: [],
    changedFiles: [],
    status: "running",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    errorSummary: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("showsRunProgress", () => {
  it("only shows once execution has started and there is at least one task", () => {
    expect(showsRunProgress("running", 2)).toBe(true);
    expect(showsRunProgress("completed", 2)).toBe(true);
    expect(showsRunProgress("running", 0)).toBe(false);
    expect(showsRunProgress("planning", 2)).toBe(false);
    expect(showsRunProgress("ready", 2)).toBe(false);
    expect(showsRunProgress("awaiting-confirmation", 2)).toBe(false);
  });
});

describe("computeTaskProgress", () => {
  it("buckets every task status and computes percent-done from terminal states only", () => {
    const progress = computeTaskProgress([
      task({ id: "a", status: "passed" }),
      task({ id: "b", status: "failed" }),
      task({ id: "c", status: "running" }),
      task({ id: "d", status: "ready" }),
    ]);
    expect(progress).toEqual({ total: 4, passed: 1, failed: 1, cancelled: 0, active: 1, queued: 1, percentDone: 50 });
  });

  it("reports zero percent done, not NaN, for an empty task list", () => {
    expect(computeTaskProgress([]).percentDone).toBe(0);
  });
});

describe("describeTaskStatus", () => {
  it("gives every task status a label and a tone", () => {
    expect(describeTaskStatus("passed").tone).toBe("success");
    expect(describeTaskStatus("failed").tone).toBe("danger");
    expect(describeTaskStatus("running").tone).toBe("info");
  });
});

describe("formatElapsedMs", () => {
  it("formats sub-minute durations as seconds and longer ones as minutes+seconds", () => {
    expect(formatElapsedMs(0)).toBe("0s");
    expect(formatElapsedMs(45_000)).toBe("45s");
    expect(formatElapsedMs(125_000)).toBe("2m 05s");
  });

  it("never returns a negative duration for a clock skew", () => {
    expect(formatElapsedMs(-500)).toBe("0s");
  });
});

describe("taskElapsedLabel", () => {
  const now = new Date("2026-08-30T00:00:30.000Z").getTime();

  it("ticks live off a still-running attempt", () => {
    const label = taskElapsedLabel([attempt({ status: "running", createdAt: "2026-08-30T00:00:00.000Z" })], "task-1", now);
    expect(label).toBe("30s");
  });

  it("reports a fixed duration once the last attempt has completed", () => {
    const label = taskElapsedLabel(
      [attempt({ status: "passed", createdAt: "2026-08-30T00:00:00.000Z", completedAt: "2026-08-30T00:00:10.000Z" })],
      "task-1",
      now,
    );
    expect(label).toBe("10s");
  });

  it("returns null when the task has no attempts yet", () => {
    expect(taskElapsedLabel([], "task-1", now)).toBeNull();
  });
});

describe("computeBudgetUsage / budgetTone", () => {
  const budget: Orchestration["budget"] = {
    maxInputTokens: 10_000,
    maxOutputTokens: null,
    maxEstimatedUsd: null,
    maxModelCalls: 40,
    maxSteps: 40,
    maxWorkerAttempts: 3,
    maxContextExpansionsPerTask: 3,
    maxWallClockMs: 1_200_000,
  };

  it("sums per-role model calls and pairs each meter with its configured cap, leaving uncapped meters at null percent", () => {
    const usage: UsageLedger = {
      byRole: {
        planner: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, modelId: "ep-planner", estimatedUsd: null, modelCalls: 1 },
        worker: { inputTokens: 8_900, cachedInputTokens: 0, outputTokens: 500, modelId: "ep-worker", estimatedUsd: null, modelCalls: 35 },
      },
      totalInputTokens: 9_000,
      totalCachedInputTokens: 0,
      totalOutputTokens: 550,
      totalEstimatedUsd: null,
      pricingStatus: "unknown",
    };
    const result = computeBudgetUsage(usage, budget);
    expect(result.modelCalls).toEqual({ label: "Model calls", used: 36, max: 40, percent: 90 });
    expect(result.inputTokens).toEqual({ label: "Input tokens", used: 9_000, max: 10_000, percent: 90 });
    expect(result.outputTokens.max).toBeNull();
    expect(result.outputTokens.percent).toBeNull();
  });

  it("caps a meter's percent at 100 even if usage overshoots the configured limit", () => {
    const usage: UsageLedger = {
      byRole: {},
      totalInputTokens: 15_000,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedUsd: null,
      pricingStatus: "unknown",
    };
    expect(computeBudgetUsage(usage, budget).inputTokens.percent).toBe(100);
  });

  it("escalates tone only near a meter's own cap, and treats an uncapped meter as informational", () => {
    expect(budgetTone(null)).toBe("info");
    expect(budgetTone(50)).toBe("info");
    expect(budgetTone(75)).toBe("warning");
    expect(budgetTone(95)).toBe("danger");
  });
});

describe("sortOrchestrationsByRecency", () => {
  it("orders newest first regardless of input order", () => {
    const older = orchestration({ id: "older", createdAt: "2026-08-30T08:00:00.000Z" });
    const newer = orchestration({ id: "newer", createdAt: "2026-08-30T10:00:00.000Z" });
    const middle = orchestration({ id: "middle", createdAt: "2026-08-30T09:00:00.000Z" });
    expect(sortOrchestrationsByRecency([older, newer, middle]).map((o) => o.id)).toEqual(["newer", "middle", "older"]);
  });
});

describe("formatOrchestrationHistoryLabel", () => {
  it("includes the status and a truncated single-line prompt preview", () => {
    const label = formatOrchestrationHistoryLabel(
      orchestration({ status: "completed", prompt: "Add   password\nreset   flow", createdAt: "2026-08-30T10:04:00.000Z" }),
    );
    expect(label).toContain("Completed");
    expect(label).toContain("Add password reset flow");
    expect(label).not.toMatch(/\n/);
  });

  it("truncates a long prompt rather than rendering the whole thing", () => {
    const label = formatOrchestrationHistoryLabel(orchestration({ prompt: "x".repeat(200) }));
    expect(label.length).toBeLessThan(120);
    expect(label).toContain("…");
  });

  it("falls back to a placeholder rather than an empty label for a blank prompt", () => {
    expect(formatOrchestrationHistoryLabel(orchestration({ prompt: "   " }))).toContain("(no prompt)");
  });
});
