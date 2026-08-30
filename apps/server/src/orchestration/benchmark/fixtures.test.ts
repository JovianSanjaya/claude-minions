/**
 * Deterministic test fakes for the benchmark module.
 *
 * These live in a `.test.ts` file on purpose: specification section 4.4 forbids
 * production mocks, so nothing here can be imported by application code.
 */
import { expect, it } from "vitest";
import type {
  BenchmarkAgentPort,
  BenchmarkArm,
  BenchmarkArmWorkspace,
  BenchmarkExecutor,
  BenchmarkExecutorInput,
  BenchmarkExecutorResult,
  BenchmarkSourceSnapshot,
  BenchmarkVerificationSummary,
  BenchmarkWorkspaceProvider,
} from "./service.js";
import type { UsageLedger } from "../contracts.js";

export function usage(input: {
  role?: "planner" | "worker" | "verifier" | "integrator";
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  estimatedUsd?: number | null;
  modelCalls?: number;
  pricing?: "configured" | "unknown";
}): UsageLedger {
  const role = input.role ?? "planner";
  const pricingStatus = input.pricing ?? (input.estimatedUsd == null ? "unknown" : "configured");
  return {
    byRole: {
      [role]: {
        modelId: input.modelId ?? "ep-test-model",
        inputTokens: input.inputTokens,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        outputTokens: input.outputTokens,
        estimatedUsd: pricingStatus === "configured" ? (input.estimatedUsd ?? 0) : null,
        modelCalls: input.modelCalls ?? 1,
      },
    },
    totalInputTokens: input.inputTokens,
    totalCachedInputTokens: input.cachedInputTokens ?? 0,
    totalOutputTokens: input.outputTokens,
    totalEstimatedUsd: pricingStatus === "configured" ? (input.estimatedUsd ?? 0) : null,
    pricingStatus,
  };
}

export const globalCheckPassed: BenchmarkVerificationSummary = {
  scope: "global",
  commandOrCheck: "npm run check",
  status: "passed",
  outputSummary: "all suites passed",
};

export const globalCheckFailed: BenchmarkVerificationSummary = {
  scope: "global",
  commandOrCheck: "npm run check",
  status: "failed",
  outputSummary: "1 suite failed",
};

export const protectedCheckPassed: BenchmarkVerificationSummary = {
  scope: "protected",
  commandOrCheck: "protected-acceptance",
  status: "passed",
  outputSummary: "acceptance criteria satisfied",
};

export class FakeAgentPort implements BenchmarkAgentPort {
  constructor(
    private readonly agents: Array<{ id: string; status: string; workspacePath: string }>,
  ) {}

  async getAgent(agentId: string) {
    return this.agents.find((agent) => agent.id === agentId) ?? null;
  }
}

/** In-memory snapshot provider. Every clone reports the same source hash. */
export class FakeWorkspaceProvider implements BenchmarkWorkspaceProvider {
  readonly clonedArms: BenchmarkArm[] = [];
  readonly disposed: string[] = [];

  constructor(
    private readonly sourceHash = "snapshot-hash-aaa",
    private readonly cloneHash: (arm: BenchmarkArm) => string = () => sourceHash,
  ) {}

  async capture(input: { benchmarkId: string }): Promise<BenchmarkSourceSnapshot> {
    const clonedArms = this.clonedArms;
    const disposed = this.disposed;
    const cloneHash = this.cloneHash;
    return {
      sourceSnapshotHash: this.sourceHash,
      clone: async (arm: BenchmarkArm): Promise<BenchmarkArmWorkspace> => {
        clonedArms.push(arm);
        const label = "benchmark-" + input.benchmarkId + "/arm-" + arm;
        return {
          label,
          path: "/tmp/does-not-exist/" + label,
          snapshotHash: cloneHash(arm),
          dispose: async () => {
            disposed.push(label);
          },
        };
      },
      dispose: async () => {
        disposed.push("source");
      },
    };
  }
}

/** Records the exact input each arm received so leakage can be asserted. */
export class RecordingExecutor implements BenchmarkExecutor {
  readonly seen: BenchmarkExecutorInput[] = [];
  readonly cancelled: string[] = [];

  constructor(
    readonly arm: BenchmarkArm,
    private readonly behaviour:
      | { kind: "result"; result: BenchmarkExecutorResult }
      | { kind: "throw"; message: string }
      | { kind: "hang" },
  ) {}

  async execute(input: BenchmarkExecutorInput): Promise<BenchmarkExecutorResult> {
    this.seen.push(input);
    if (this.behaviour.kind === "throw") {
      throw new Error(this.behaviour.message);
    }
    if (this.behaviour.kind === "hang") {
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Arm cancelled");
    }
    return structuredClone(this.behaviour.result);
  }

  async cancel(benchmarkId: string): Promise<void> {
    this.cancelled.push(benchmarkId);
  }
}

export function result(
  overrides: Partial<BenchmarkExecutorResult> & { executionId: string },
): BenchmarkExecutorResult {
  return {
    selectedMode: "direct",
    succeeded: true,
    verifications: [globalCheckPassed],
    usage: usage({ inputTokens: 1_000, outputTokens: 100 }),
    counters: {},
    ...overrides,
  };
}

// Vitest requires at least one test per collected file.
it("exposes deterministic fakes only to tests", () => {
  expect(new FakeWorkspaceProvider()).toBeInstanceOf(FakeWorkspaceProvider);
});
