import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetPolicySchema } from "../control/budget-ledger.js";
import type {
  BudgetPolicy,
  ExecutionContract,
  Orchestration,
  ContractCriterion,
} from "../contracts.js";
import { createEngineDriver } from "./driver.js";
import { createFakeAgentRunner, createInMemorySink } from "./test-doubles.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

type Handler = (request: RunnerRequest) => RunnerResult | Promise<RunnerResult>;

function scenarioRunner(handlers: {
  elaborate?: Handler;
  preflight?: Handler;
  write?: Handler;
  direct?: Handler;
  integrator?: Handler;
}): AgentRunner {
  // A structured-output repair call doesn't repeat the original prompt's
  // marker text (it's a fresh "your previous response was malformed"
  // prompt) — reuse whichever handler served the immediately preceding,
  // non-repair call so a repair round-trip reaches the same fixture.
  let lastHandler: Handler | undefined;
  return createFakeAgentRunner(async (request) => {
    if (request.prompt.startsWith("Your previous response could not be parsed") && lastHandler) {
      return lastHandler(request);
    }
    let handler: Handler | undefined;
    if (request.prompt.includes("establishing common ground")) handler = handlers.elaborate;
    else if (request.prompt.includes("READ-ONLY planning step")) handler = handlers.preflight;
    else if (request.prompt.startsWith("Implement the confirmed request")) handler = handlers.direct;
    else if (request.prompt.includes("both changed")) handler = handlers.integrator;
    else if (request.prompt.startsWith("Implement task")) handler = handlers.write;
    if (!handler) throw new Error("Unhandled fake runner prompt: " + request.prompt.slice(0, 120));
    lastHandler = handler;
    return handler(request);
  });
}

function ok(output: string): RunnerResult {
  return { output, threadId: null, usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 30 } };
}

const defaultPreflightPlan = JSON.stringify({
  understanding: "Understood",
  filesExpectedToChange: [],
  approach: "Straightforward change",
  missingContextRequests: [],
  plannedChecks: [],
});

function elaborationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: "Add password reset",
    requirements: [
      { text: "Users can request a reset email", provenance: "user-explicit", materiality: "trivial", rationale: null },
    ],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    manualExpectations: [],
    openQuestions: [],
    estimate: { inputTokenLow: 100, inputTokenHigh: 500, outputTokenLow: 50, outputTokenHigh: 200, assumptions: [] },
    ...overrides,
  });
}

function criterion(id: string, description: string, kind: ContractCriterion["kind"] = "functional"): ContractCriterion {
  return { id, kind, description, verification: "visible-test", provenance: "user-explicit", sourceClaimId: null };
}

function buildContract(criteria: ContractCriterion[]): ExecutionContract {
  return {
    id: "contract-1",
    orchestrationId: "orch-1",
    version: 1,
    intent: {
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
    },
    criteria,
    confirmedBy: "user",
    confirmedAt: new Date().toISOString(),
    supersedesContractId: null,
  };
}

function buildOrchestration(overrides: Partial<Orchestration> = {}, budget?: BudgetPolicy): Orchestration {
  return {
    id: "orch-1",
    agentId: "agent-1",
    prompt: "Add password reset",
    requestedMode: "auto",
    selectedMode: null,
    status: "planning",
    currentIntentDraftId: "draft-1",
    activeContractId: "contract-1",
    estimate: null,
    budget: budget ?? budgetPolicySchema.parse({}),
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

describe("createEngineDriver: elaborateIntent", () => {
  it("validates the structured planner output against the grounding schema", async () => {
    const workspacePath = await tempDir("driver-elaborate-");
    const runner = scenarioRunner({ elaborate: () => ok(elaborationJson()) });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const sink = createInMemorySink();
    const { draft, estimate } = await driver.elaborateIntent(
      { orchestrationId: "orch-1", agentId: "agent-1", prompt: "Add password reset", requestedMode: "auto", budget: budgetPolicySchema.parse({}), workspacePath, priorDraft: null },
      sink,
      new AbortController().signal,
    );
    expect(draft.goal).toBe("Add password reset");
    expect(draft.requirements[0]?.provenance).toBe("user-explicit");
    expect(estimate.inputTokenLow).toBe(100);
    expect(estimate.pricingStatus).toBe("unknown");
  });

  it("identifies a material ambiguity in a deterministic fixture", async () => {
    const workspacePath = await tempDir("driver-elaborate-");
    const runner = scenarioRunner({
      elaborate: () =>
        ok(
          elaborationJson({
            openQuestions: [
              {
                prompt: "Should reset tokens expire in 1h or 24h?",
                materiality: "material",
                consequenceIfWrong: "Security/UX tradeoff",
                category: "requirements",
                options: [
                  { label: "1h", resolutionText: "Expires in 1h", delegate: false },
                  { label: "AI decides", resolutionText: "Expires in 1h (safe default)", delegate: true },
                ],
              },
            ],
          }),
        ),
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const sink = createInMemorySink();
    const { draft } = await driver.elaborateIntent(
      { orchestrationId: "orch-1", agentId: "agent-1", prompt: "x", requestedMode: "auto", budget: budgetPolicySchema.parse({}), workspacePath, priorDraft: null },
      sink,
      new AbortController().signal,
    );
    expect(draft.openQuestions).toHaveLength(1);
    expect(draft.openQuestions[0]?.materiality).toBe("material");
    expect(draft.openQuestions[0]?.options.some((option) => option.delegate)).toBe(true);
  });

  it("identifies an inconsequential choice as a trivial question safe to delegate", async () => {
    const workspacePath = await tempDir("driver-elaborate-");
    const runner = scenarioRunner({
      elaborate: () =>
        ok(
          elaborationJson({
            openQuestions: [
              {
                prompt: "Query param or path segment for the reset link?",
                materiality: "trivial",
                consequenceIfWrong: "Cosmetic only",
                category: "architectureDecisions",
                options: [{ label: "query param", resolutionText: "Use a query param", delegate: true }],
              },
            ],
          }),
        ),
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const sink = createInMemorySink();
    const { draft } = await driver.elaborateIntent(
      { orchestrationId: "orch-1", agentId: "agent-1", prompt: "x", requestedMode: "auto", budget: budgetPolicySchema.parse({}), workspacePath, priorDraft: null },
      sink,
      new AbortController().signal,
    );
    // this restricted build itself does NOT auto-resolve trivial questions —
    // that policy lives in Task 1's control plane (clarification-policy.ts),
    // which consumes exactly this materiality signal from the driver.
    expect(draft.openQuestions).toHaveLength(1);
    expect(draft.openQuestions[0]?.materiality).toBe("trivial");
  });

  it("recovers via one bounded repair when the planner's first output is malformed", async () => {
    const workspacePath = await tempDir("driver-elaborate-");
    let calls = 0;
    const runner = scenarioRunner({
      elaborate: () => {
        calls += 1;
        return calls === 1 ? ok("not json") : ok(elaborationJson());
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const sink = createInMemorySink();
    const { draft } = await driver.elaborateIntent(
      { orchestrationId: "orch-1", agentId: "agent-1", prompt: "x", requestedMode: "auto", budget: budgetPolicySchema.parse({}), workspacePath, priorDraft: null },
      sink,
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    expect(draft.goal).toBe("Add password reset");
  });
});

describe("createEngineDriver: routing", () => {
  it("routes a tiny/coupled contract to direct execution", async () => {
    const workspacePath = await tempDir("driver-route-");
    const driver = createEngineDriver({
      runner: scenarioRunner({}),
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const contract = buildContract([criterion("c1", "Add a reset endpoint")]);
    const plan = await driver.plan(
      { orchestration: buildOrchestration(), contract, workspacePath },
      createInMemorySink(),
      new AbortController().signal,
    );
    expect(plan.selectedMode).toBe("direct");
    expect(plan.tasks).toEqual([]);
  });

  it("routes a modular contract spanning multiple directories to multi-worker", async () => {
    const workspacePath = await tempDir("driver-route-");
    await mkdir(path.join(workspacePath, "auth"), { recursive: true });
    await mkdir(path.join(workspacePath, "email"), { recursive: true });
    await writeFile(path.join(workspacePath, "auth", "reset.ts"), "export {};\n");
    await writeFile(path.join(workspacePath, "email", "send.ts"), "export {};\n");

    const driver = createEngineDriver({
      runner: scenarioRunner({}),
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const contract = buildContract([
      criterion("c1", "Update the auth module to issue tokens"),
      criterion("c2", "Update the email module to send messages"),
    ]);
    const plan = await driver.plan(
      { orchestration: buildOrchestration({ requestedMode: "orchestrated" }), contract, workspacePath },
      createInMemorySink(),
      new AbortController().signal,
    );
    expect(plan.selectedMode).toBe("multi-worker");
    expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
    expect(plan.applicationMap.fileCount).toBe(2);
  });
});

describe("createEngineDriver: execute — direct mode", () => {
  it("completes and verifies a direct-mode execution", async () => {
    const workspacePath = await tempDir("driver-direct-");
    await writeFile(path.join(workspacePath, "app.ts"), "export {};\n");
    const runner = scenarioRunner({
      direct: async (request) => {
        await writeFile(path.join(request.workspacePath, "app.ts"), "export const reset = true;\n");
        return ok("done");
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [{ name: "protected", scope: "protected" }],
      globalChecks: [{ name: "global", scope: "global" }],
    });
    const contract = buildContract([criterion("c1", "Add a reset endpoint")]);
    const orchestration = buildOrchestration();
    const plan = { selectedMode: "direct" as const, routeReason: "small", tasks: [], applicationMap: { orchestrationId: "orch-1", version: 1, repositoryHash: "h", summary: "", fileCount: 1, createdAt: new Date().toISOString() } };
    const sink = createInMemorySink();

    const outcome = await driver.execute({ orchestration, contract, workspacePath, plan }, sink, new AbortController().signal);
    expect(outcome).toEqual({ kind: "completed", finalOutput: "Direct execution completed and verified" });
    expect(await readFile(path.join(workspacePath, "app.ts"), "utf8")).toBe("export const reset = true;\n");
    expect(sink.verifications.length).toBe(2);
  });

  it("fails without touching anything else when global verification fails after direct execution", async () => {
    const workspacePath = await tempDir("driver-direct-");
    const runner = scenarioRunner({ direct: () => ok("done") });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "failed", outputSummary: "broke the build" }),
      protectedChecks: [],
      globalChecks: [{ name: "global", scope: "global" }],
    });
    const contract = buildContract([criterion("c1", "x")]);
    const plan = { selectedMode: "direct" as const, routeReason: "small", tasks: [], applicationMap: { orchestrationId: "orch-1", version: 1, repositoryHash: "h", summary: "", fileCount: 0, createdAt: new Date().toISOString() } };
    const outcome = await driver.execute(
      { orchestration: buildOrchestration(), contract, workspacePath, plan },
      createInMemorySink(),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
  });

  it("maps a denied budget reservation to a budget-exhausted outcome", async () => {
    const workspacePath = await tempDir("driver-direct-");
    const tightBudget = budgetPolicySchema.parse({ maxInputTokens: 1 });
    const driver = createEngineDriver({
      runner: scenarioRunner({ direct: () => ok("done") }),
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const contract = buildContract([criterion("c1", "x")]);
    const plan = { selectedMode: "direct" as const, routeReason: "small", tasks: [], applicationMap: { orchestrationId: "orch-1", version: 1, repositoryHash: "h", summary: "", fileCount: 0, createdAt: new Date().toISOString() } };
    const outcome = await driver.execute(
      { orchestration: buildOrchestration({}, tightBudget), contract, workspacePath, plan },
      createInMemorySink(tightBudget),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("budget-exhausted");
  });
});

describe("createEngineDriver: execute — multi-worker", () => {
  async function setupMultiWorkerWorkspace() {
    const workspacePath = await tempDir("driver-multi-");
    await mkdir(path.join(workspacePath, "auth"), { recursive: true });
    await mkdir(path.join(workspacePath, "email"), { recursive: true });
    await writeFile(path.join(workspacePath, "auth", "reset.ts"), "// original\n");
    await writeFile(path.join(workspacePath, "email", "send.ts"), "// original\n");
    return workspacePath;
  }

  it("runs isolated workers, integrates deterministically, verifies, publishes, and records artifacts", async () => {
    const workspacePath = await setupMultiWorkerWorkspace();
    const runner = scenarioRunner({
      preflight: () => ok(defaultPreflightPlan),
      write: async (request) => {
        const target = request.prompt.includes("auth") ? path.join("auth", "reset.ts") : path.join("email", "send.ts");
        await writeFile(path.join(request.workspacePath, target), "// updated\n");
        return ok("edited");
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [{ name: "protected", scope: "protected" }],
      globalChecks: [{ name: "global", scope: "global" }],
    });
    const contract = buildContract([
      criterion("c1", "Update the auth module to issue tokens"),
      criterion("c2", "Update the email module to send messages"),
    ]);
    const sink = createInMemorySink();
    const orchestration = buildOrchestration({ requestedMode: "orchestrated" });
    const plan = await driver.plan({ orchestration, contract, workspacePath }, sink, new AbortController().signal);
    expect(plan.selectedMode).toBe("multi-worker");

    const outcome = await driver.execute({ orchestration, contract, workspacePath, plan }, sink, new AbortController().signal);
    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspacePath, "auth", "reset.ts"), "utf8")).toBe("// updated\n");
    expect(await readFile(path.join(workspacePath, "email", "send.ts"), "utf8")).toBe("// updated\n");
    expect(sink.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(sink.tasks.every((task) => task.status === "passed")).toBe(true);
  });

  it("leaves the main workspace unchanged and returns needs-user when a worker repeatedly fails with an ambiguous-contract signal", async () => {
    const workspacePath = await setupMultiWorkerWorkspace();
    const runner = scenarioRunner({
      preflight: () => ok(defaultPreflightPlan),
      write: async (request) => {
        // touches a file but the check will report an ambiguous contract conflict
        await writeFile(path.join(request.workspacePath, "auth", "reset.ts"), "// attempted\n");
        return ok("edited");
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "failed", outputSummary: "This looks like a contract conflict: public API must change" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const contract = buildContract([criterion("c1", "Update the auth module to issue tokens")]);
    const budget = budgetPolicySchema.parse({ maxWorkerAttempts: 2 });
    const sink = createInMemorySink(budget);
    const orchestration = buildOrchestration({ requestedMode: "orchestrated" }, budget);
    const plan = await driver.plan({ orchestration, contract, workspacePath }, sink, new AbortController().signal);

    const outcome = await driver.execute({ orchestration, contract, workspacePath, plan }, sink, new AbortController().signal);
    expect(outcome.kind).toBe("needs-user");
    if (outcome.kind === "needs-user") {
      expect(outcome.amendment.material).toBe(true);
      expect(outcome.amendment.reason).toMatch(/conflict/i);
    }
    // nothing was published to the main workspace
    expect(await readFile(path.join(workspacePath, "auth", "reset.ts"), "utf8")).toBe("// original\n");
  });

  it("returns a plain failed outcome (not needs-user) for an ordinary implementation failure", async () => {
    const workspacePath = await setupMultiWorkerWorkspace();
    const runner = scenarioRunner({
      preflight: () => ok(defaultPreflightPlan),
      write: async (request) => {
        await writeFile(path.join(request.workspacePath, "auth", "reset.ts"), "// broken\n");
        return ok("edited");
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "failed", outputSummary: "TypeError: undefined is not a function" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const contract = buildContract([criterion("c1", "Update the auth module to issue tokens")]);
    const budget = budgetPolicySchema.parse({ maxWorkerAttempts: 2 });
    const sink = createInMemorySink(budget);
    const orchestration = buildOrchestration({ requestedMode: "orchestrated" }, budget);
    const plan = await driver.plan({ orchestration, contract, workspacePath }, sink, new AbortController().signal);
    const outcome = await driver.execute({ orchestration, contract, workspacePath, plan }, sink, new AbortController().signal);
    expect(outcome.kind).toBe("failed");
    expect(await readFile(path.join(workspacePath, "auth", "reset.ts"), "utf8")).toBe("// original\n");
  });

  it("resolves a genuine cross-worker conflict and still publishes", async () => {
    const workspacePath = await tempDir("driver-conflict-");
    await mkdir(path.join(workspacePath, "auth"), { recursive: true });
    await writeFile(path.join(workspacePath, "auth", "reset.ts"), "// original\n");

    const runner = scenarioRunner({
      preflight: () => ok(defaultPreflightPlan),
      write: async (request) => {
        const marker = request.prompt.includes("Task 1") ? "A" : "B";
        await writeFile(path.join(request.workspacePath, "auth", "reset.ts"), `// version ${marker}\n`);
        return ok("edited");
      },
      integrator: async (request) => {
        await writeFile(path.join(request.workspacePath, "auth", "reset.ts"), "// reconciled\n");
        return ok("reconciled");
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    // two functional criteria that both cluster into the same "auth" directory -> two tasks touching the same allowedPaths
    const contract = buildContract([
      criterion("c1", "Update the auth module: part one"),
      criterion("c2", "Update the auth module: part two"),
    ]);
    const sink = createInMemorySink();
    const orchestration = buildOrchestration({ requestedMode: "orchestrated" });
    // Force two separate tasks touching the same directory by planning directly rather than via the clustering heuristic
    const plan = {
      selectedMode: "multi-worker" as const,
      routeReason: "forced two tasks for conflict test",
      tasks: [
        {
          id: "task-a",
          orchestrationId: "orch-1",
          title: "Task 1: auth",
          objective: "part one",
          status: "ready" as const,
          dependsOn: [],
          allowedPaths: ["auth"],
          acceptanceCriterionIds: ["c1"],
          requiredArtifactIds: [],
          observedArtifactVersions: {},
          applicationMapVersion: 1,
          attemptCount: 0,
        },
        {
          id: "task-b",
          orchestrationId: "orch-1",
          title: "Task 2: auth",
          objective: "part two",
          status: "ready" as const,
          dependsOn: [],
          allowedPaths: ["auth"],
          acceptanceCriterionIds: ["c2"],
          requiredArtifactIds: [],
          observedArtifactVersions: {},
          applicationMapVersion: 1,
          attemptCount: 0,
        },
      ],
      applicationMap: { orchestrationId: "orch-1", version: 1, repositoryHash: "h", summary: "", fileCount: 1, createdAt: new Date().toISOString() },
    };

    const outcome = await driver.execute({ orchestration, contract, workspacePath, plan }, sink, new AbortController().signal);
    expect(outcome.kind).toBe("completed");
    expect(await readFile(path.join(workspacePath, "auth", "reset.ts"), "utf8")).toBe("// reconciled\n");
  });
});

describe("createEngineDriver: cancellation", () => {
  it("cancel() causes a subsequent execute() call to return a cancelled outcome immediately", async () => {
    const workspacePath = await tempDir("driver-cancel-");
    await writeFile(path.join(workspacePath, "app.ts"), "export {};\n");
    let directCalled = false;
    const runner = scenarioRunner({
      direct: () => {
        directCalled = true;
        return ok("done");
      },
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    await driver.cancel("orch-1");

    const contract = buildContract([criterion("c1", "x")]);
    const plan = { selectedMode: "direct" as const, routeReason: "small", tasks: [], applicationMap: { orchestrationId: "orch-1", version: 1, repositoryHash: "h", summary: "", fileCount: 0, createdAt: new Date().toISOString() } };
    const outcome = await driver.execute(
      { orchestration: buildOrchestration(), contract, workspacePath, plan },
      createInMemorySink(),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("cancelled");
    expect(directCalled).toBe(false);
  });

  it("an aborted signal stops a multi-worker execution and cleans up isolated workspaces", async () => {
    const workspacePath = await tempDir("driver-cancel-multi-");
    await mkdir(path.join(workspacePath, "auth"), { recursive: true });
    await mkdir(path.join(workspacePath, "email"), { recursive: true });
    await writeFile(path.join(workspacePath, "auth", "reset.ts"), "// original\n");
    await writeFile(path.join(workspacePath, "email", "send.ts"), "// original\n");

    const controller = new AbortController();
    const runner = scenarioRunner({
      preflight: () => {
        controller.abort();
        return ok(defaultPreflightPlan);
      },
      write: () => ok("should not run after abort"),
    });
    const driver = createEngineDriver({
      runner,
      modelIds: {},
      defaultModelId: "ep-default",
      scratchRoot: await tempDir("driver-scratch-"),
      checkRunner: async () => ({ status: "passed", outputSummary: "ok" }),
      protectedChecks: [],
      globalChecks: [],
    });
    const contract = buildContract([
      criterion("c1", "Update the auth module"),
      criterion("c2", "Update the email module"),
    ]);
    const sink = createInMemorySink();
    const orchestration = buildOrchestration({ requestedMode: "orchestrated" });
    const plan = await driver.plan({ orchestration, contract, workspacePath }, sink, new AbortController().signal);

    const outcome = await driver.execute({ orchestration, contract, workspacePath, plan }, sink, controller.signal);
    expect(outcome.kind).toBe("cancelled");
    expect(await readFile(path.join(workspacePath, "auth", "reset.ts"), "utf8")).toBe("// original\n");
  });
});
