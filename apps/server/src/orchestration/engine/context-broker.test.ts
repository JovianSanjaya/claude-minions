import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BudgetPolicy,
  ExecutionContract,
  OrchestrationTask,
  SharedArtifact,
} from "../contracts.js";
import { buildApplicationMap } from "./application-map.js";
import { ContextBroker, matchesAllowedPath } from "./context-broker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const budget: BudgetPolicy = {
  maxInputTokens: null,
  maxOutputTokens: null,
  maxEstimatedUsd: null,
  maxModelCalls: 40,
  maxSteps: 60,
  maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 1,
  maxWallClockMs: 900_000,
};

const contract: ExecutionContract = {
  id: "contract-1",
  orchestrationId: "orc-1",
  version: 1,
  intent: {
    id: "draft-1",
    orchestrationId: "orc-1",
    revision: 1,
    goal: "Add password reset",
    requirements: [],
    assumptions: [],
    nonGoals: [],
    architectureDecisions: [],
    materialQuestions: [],
    manualExpectations: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  criteria: [
    {
      id: "FR-1",
      kind: "functional",
      description: "Reset tokens expire",
      verification: "visible-test",
    },
    {
      id: "FR-9",
      kind: "functional",
      description: "Unrelated criterion",
      verification: "visible-test",
    },
  ],
  confirmedBy: "user",
  confirmedAt: "2026-01-01T00:00:00.000Z",
  supersedesContractId: null,
};

const task: OrchestrationTask = {
  id: "task-api",
  orchestrationId: "orc-1",
  title: "API",
  objective: "Implement the reset endpoint",
  status: "ready",
  dependsOn: [],
  allowedPaths: ["src/api/**"],
  acceptanceCriterionIds: ["FR-1"],
  requiredArtifactIds: ["reset-token-contract"],
  observedArtifactVersions: {},
  applicationMapVersion: 1,
  attemptCount: 0,
};

const artifact: SharedArtifact = {
  id: "artifact-1",
  orchestrationId: "orc-1",
  producerTaskId: "task-persistence",
  kind: "interface",
  name: "reset-token-contract",
  version: 2,
  payload: "interface ResetToken { id: string; expiresAt: string }",
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "broker-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src", "api"), { recursive: true });
  await mkdir(path.join(root, "src", "web"), { recursive: true });
  await writeFile(
    path.join(root, "src", "api", "reset.ts"),
    'import { Token } from "../schema.js";\nexport const reset = () => null;\n',
  );
  await writeFile(path.join(root, "src", "schema.ts"), "export interface Token { id: string }\n");
  await writeFile(path.join(root, "src", "web", "form.ts"), "export const form = 1;\n");
  await writeFile(path.join(root, "src", "web", "unrelated.ts"), "export const noise = 1;\n");
  await writeFile(path.join(root, ".env"), "ARK_API_KEY=super-secret\n");
  return root;
}

describe("allowed-path matching", () => {
  it("matches prefixes and globs without matching siblings", () => {
    expect(matchesAllowedPath("src/api/reset.ts", ["src/api/**"])).toBe(true);
    expect(matchesAllowedPath("src/api/nested/deep.ts", ["src/api/**"])).toBe(true);
    expect(matchesAllowedPath("src/web/form.ts", ["src/api/**"])).toBe(false);
    expect(matchesAllowedPath("src/api/reset.ts", ["src/api/"])).toBe(true);
    expect(matchesAllowedPath("src/apiary/x.ts", ["src/api/**"])).toBe(false);
    expect(matchesAllowedPath("src/api/reset.ts", ["src/*/reset.ts"])).toBe(true);
  });
});

describe("context packets", () => {
  it("includes only the task scope plus one dependency hop", async () => {
    const root = await makeWorkspace();
    const map = await buildApplicationMap(root);
    const broker = new ContextBroker();
    const packet = await broker.buildPacket({
      task,
      contract,
      map,
      artifacts: [artifact],
      workspacePath: root,
    });

    const paths = packet.summary.sourceFiles.map((file) => file.path);
    expect(paths).toContain("src/api/reset.ts");
    expect(paths).toContain("src/schema.ts");
    expect(paths).not.toContain("src/web/unrelated.ts");
    expect(paths).not.toContain(".env");
    expect(packet.rendered).not.toContain("super-secret");
  });

  it("records hashes, byte counts and a token estimate rather than source", async () => {
    const root = await makeWorkspace();
    const map = await buildApplicationMap(root);
    const packet = await new ContextBroker().buildPacket({
      task,
      contract,
      map,
      artifacts: [artifact],
      workspacePath: root,
    });
    expect(packet.summary.estimatedTokens).toBeGreaterThan(0);
    expect(packet.summary.contractVersion).toBe(1);
    expect(packet.summary.applicationMapVersion).toBe(map.version);
    expect(packet.summary.artifactVersions).toEqual({ "reset-token-contract": 2 });
    expect(packet.summary.relevantInterfaces).toEqual(["reset-token-contract@v2"]);
    for (const file of packet.summary.sourceFiles) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
    }
    expect(JSON.stringify(packet.summary)).not.toContain("export const reset");
  });

  it("carries only the acceptance criteria that belong to the task", async () => {
    const root = await makeWorkspace();
    const map = await buildApplicationMap(root);
    const packet = await new ContextBroker().buildPacket({
      task,
      contract,
      map,
      artifacts: [],
      workspacePath: root,
    });
    expect(packet.rendered).toContain("FR-1");
    expect(packet.rendered).not.toContain("FR-9");
  });
});

describe("narrow context expansion", () => {
  it("grants a validated in-workspace file", async () => {
    const root = await makeWorkspace();
    const decision = await new ContextBroker().evaluateExpansion({
      workspacePath: root,
      requestedPath: "src/web/form.ts",
      reason: "The API must call the same form contract",
      priorExpansions: 0,
      budget,
    });
    expect(decision).toMatchObject({ allowed: true, resolvedPath: "src/web/form.ts" });
  });

  it("denies traversal outside the workspace", async () => {
    const root = await makeWorkspace();
    const decision = await new ContextBroker().evaluateExpansion({
      workspacePath: root,
      requestedPath: "../../etc/passwd",
      reason: "I would like to look around",
      priorExpansions: 0,
      budget,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("traverse");
  });

  it("denies a symlink that escapes the workspace", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(path.join(tmpdir(), "broker-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "escape.ts"));
    const decision = await new ContextBroker().evaluateExpansion({
      workspacePath: root,
      requestedPath: "src/escape.ts",
      reason: "This looks interesting to me",
      priorExpansions: 0,
      budget,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("escapes");
  });

  it("denies credential-shaped and protected paths", async () => {
    const root = await makeWorkspace();
    const protectedRoot = path.join(root, "protected");
    await mkdir(protectedRoot, { recursive: true });
    await writeFile(path.join(protectedRoot, "acceptance.json"), "[]");
    const broker = new ContextBroker({ protectedPaths: [protectedRoot] });

    const secret = await broker.evaluateExpansion({
      workspacePath: root,
      requestedPath: ".env",
      reason: "I need the configuration values",
      priorExpansions: 0,
      budget,
    });
    expect(secret.allowed).toBe(false);
    expect(secret.reason).toContain("credential-shaped");

    const evaluator = await broker.evaluateExpansion({
      workspacePath: root,
      requestedPath: "protected/acceptance.json",
      reason: "I want to see how I am graded",
      priorExpansions: 0,
      budget,
    });
    expect(evaluator.allowed).toBe(false);
    expect(evaluator.reason).toContain("protected");
  });

  it("denies once the expansion budget is exhausted", async () => {
    const root = await makeWorkspace();
    const decision = await new ContextBroker().evaluateExpansion({
      workspacePath: root,
      requestedPath: "src/web/form.ts",
      reason: "One more file would help me finish",
      priorExpansions: 1,
      budget,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("budget exhausted");
  });

  it("requires a concrete reason", async () => {
    const root = await makeWorkspace();
    const decision = await new ContextBroker().evaluateExpansion({
      workspacePath: root,
      requestedPath: "src/web/form.ts",
      reason: "why",
      priorExpansions: 0,
      budget,
    });
    expect(decision.allowed).toBe(false);
  });
});
