import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ApplicationMapSummary,
  ContextPacketSummary,
  ModelCallReservation,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  SharedArtifact,
  TokenUsage,
  VerificationRecord,
  WorkerAttempt,
} from "../contracts.js";
import type { AgentRunner } from "../../types.js";
import {
  buildApplicationMap,
  isApplicationMapExcluded,
  isProtectedEnvironmentPath,
  isSafeEnvironmentTemplatePath,
} from "./application-map.js";
import { ArtifactRegistry } from "./artifact-registry.js";
import { ContextBroker } from "./context-broker.js";
import { classifyFailure, createFailurePacket } from "./failure-packet.js";
import { DeterministicIntegrator } from "./integrator.js";
import { reviewPreflight } from "./preflight.js";
import { RoleExecutor } from "./role-executor.js";
import { selectRoute, tasksHaveOverlappingWriteScopes } from "./router.js";
import { parseStructured, StructuredOutputError } from "./structured-output.js";
import { requiredVerificationPassed, VerificationService } from "./verification.js";
import { scopeViolations, WorkerWorkspaceManager } from "./worker-workspaces.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MemorySink implements OrchestrationSink {
  events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
  tasks: OrchestrationTask[] = [];
  maps: ApplicationMapSummary[] = [];
  packets: ContextPacketSummary[] = [];
  attempts: WorkerAttempt[] = [];
  artifacts: SharedArtifact[] = [];
  verifications: VerificationRecord[] = [];
  reservations = new Map<string, ModelCallReservation>();
  usage: TokenUsage[] = [];
  async reserveModelCall(input: ModelCallReservation) {
    const id = `r${this.reservations.size + 1}`;
    this.reservations.set(id, input);
    return { allowed: true as const, reservationId: id };
  }
  async commitModelUsage(_id: string, actual: TokenUsage) { this.usage.push(actual); }
  async recordEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">) { this.events.push(event); }
  async upsertTask(task: OrchestrationTask) {
    const index = this.tasks.findIndex((entry) => entry.id === task.id);
    if (index < 0) this.tasks.push(structuredClone(task)); else this.tasks[index] = structuredClone(task);
  }
  async recordApplicationMap(map: ApplicationMapSummary) { this.maps.push(map); }
  async recordContextPacket(packet: ContextPacketSummary) { this.packets.push(packet); }
  async recordAttempt(attempt: WorkerAttempt) { this.attempts.push(structuredClone(attempt)); }
  async publishArtifact(artifact: SharedArtifact) { this.artifacts.push(structuredClone(artifact)); }
  async recordVerification(record: VerificationRecord) { this.verifications.push(record); }
}

const budget = {
  maxInputTokens: 100_000, maxOutputTokens: 100_000, maxEstimatedUsd: null,
  maxModelCalls: 50, maxSteps: 100, maxWorkerAttempts: 3,
  maxContextExpansionsPerTask: 1,
};

describe("engine primitives", () => {
  it("parses fenced structured output and rejects malformed shapes", () => {
    expect(parseStructured(z.object({ ok: z.boolean() }), "```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
    expect(() => parseStructured(z.object({ ok: z.boolean() }), "{}"))
      .toThrow(StructuredOutputError);
  });

  it("routes tiny, coupled, and modular work adaptively within budget", () => {
    expect(selectRoute({ requestedMode: "auto", taskCount: 1, changedAreaCount: 1, hasOverlappingWriteScopes: false, coupling: "low", estimatedCalls: 2, estimatedContextTokens: 100, budget }).selectedMode).toBe("direct");
    expect(selectRoute({ requestedMode: "orchestrated", taskCount: 2, changedAreaCount: 2, hasOverlappingWriteScopes: false, coupling: "high", estimatedCalls: 4, estimatedContextTokens: 100, budget })).toEqual({
      selectedMode: "multi-worker",
      reason: "Coupled work is split into dependency-ordered workers with exclusive file ownership",
    });
    expect(selectRoute({ requestedMode: "auto", taskCount: 3, changedAreaCount: 3, hasOverlappingWriteScopes: false, coupling: "low", estimatedCalls: 8, estimatedContextTokens: 100, budget }).selectedMode).toBe("multi-worker");
    expect(() => selectRoute({ requestedMode: "orchestrated", taskCount: 8, changedAreaCount: 1, hasOverlappingWriteScopes: true, coupling: "low", estimatedCalls: 20, estimatedContextTokens: 100, budget }))
      .toThrow("must have exclusive writable paths");
    expect(tasksHaveOverlappingWriteScopes([
      { allowedPaths: ["index.html"] },
      { allowedPaths: ["index.html"] },
    ])).toBe(true);
    expect(tasksHaveOverlappingWriteScopes([
      { allowedPaths: ["src"] },
      { allowedPaths: ["src/app.ts"] },
    ])).toBe(true);
    expect(tasksHaveOverlappingWriteScopes([
      { allowedPaths: ["src/app.ts"] },
      { allowedPaths: ["tests/app.test.ts"] },
    ])).toBe(false);
  });

  it("builds a deterministic map, minimizes context, and denies traversal/symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-map-"));
    temporary.push(root);
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await mkdir(path.join(root, ".npm-cache", "_cacache"), { recursive: true });
    await writeFile(path.join(root, "src", "api.ts"), "export interface Api { ok: boolean }\n");
    await writeFile(path.join(root, "src", "other.ts"), "export const other = 1\n");
    await writeFile(path.join(root, ".env"), "ARK_API_KEY=secret\n");
    await writeFile(path.join(root, ".env.example"), "ARK_API_KEY=replace-me\n");
    await writeFile(path.join(root, "tsconfig.tsbuildinfo"), "generated compiler cache\n");
    await writeFile(path.join(root, ".eslintcache"), "generated lint cache\n");
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored");
    await writeFile(path.join(root, ".npm-cache", "_cacache", "ignored"), "cache");
    await symlink(path.join(root, ".env"), path.join(root, "src", "escape.ts"));
    const map = await buildApplicationMap(root, "o1");
    expect(map.entries.map((entry) => entry.path)).toEqual([".env.example", "src/api.ts", "src/other.ts"]);
    const task: OrchestrationTask = {
      id: "t1", orchestrationId: "o1", title: "API", objective: "Change API",
      status: "ready", dependsOn: [], allowedPaths: ["src/api.ts"],
      acceptanceCriterionIds: ["c1"], requiredArtifactIds: [],
      observedArtifactVersions: {}, applicationMapVersion: 1, attemptCount: 0,
    };
    const broker = new ContextBroker(root, 1);
    const packet = await broker.createPacket(task, map, 1, {});
    expect(packet.summary.sourceFiles.map((file) => file.path)).toEqual(["src/api.ts"]);
    await expect(broker.expand(task, map, 1, {}, ["../.env"], "need it"))
      .rejects.toThrow("invalid context path");
    const bounded = new ContextBroker(root, 1);
    expect((await bounded.expand(task, map, 1, {}, ["src/other.ts"], "need interface")).summary.sourceFiles)
      .toHaveLength(1);
    await expect(bounded.expand(task, map, 1, {}, ["src/api.ts"], "another"))
      .rejects.toThrow("budget exhausted");
  });

  it("allows environment templates while protecting real environment files at any depth", () => {
    for (const template of [
      ".env.example",
      ".env.sample",
      ".env.template",
      "apps/web/.env.example",
    ]) {
      expect(isSafeEnvironmentTemplatePath(template)).toBe(true);
      expect(isProtectedEnvironmentPath(template)).toBe(false);
      expect(isApplicationMapExcluded(template)).toBe(false);
    }
    for (const secretFile of [
      ".env",
      ".env.local",
      ".env.production",
      "apps/server/.env",
      "apps/server/.env.production.local",
    ]) {
      expect(isSafeEnvironmentTemplatePath(secretFile)).toBe(false);
      expect(isProtectedEnvironmentPath(secretFile)).toBe(true);
      expect(isApplicationMapExcluded(secretFile)).toBe(true);
    }
  });

  it("excludes generated compiler and lint artifacts from maps and scope accounting", () => {
    expect(isApplicationMapExcluded("tsconfig.tsbuildinfo")).toBe(true);
    expect(isApplicationMapExcluded("apps/web/tsconfig.app.tsbuildinfo")).toBe(true);
    expect(isApplicationMapExcluded(".eslintcache")).toBe(true);
    expect(isApplicationMapExcluded("src/application.ts")).toBe(false);
  });

  it("isolates worker changes, detects scope violations, and cleans only task paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-workspace-"));
    temporary.push(root);
    const source = path.join(root, "source");
    await mkdir(path.join(source, "src"), { recursive: true });
    await writeFile(path.join(source, "src", "a.ts"), "a\n");
    const manager = new WorkerWorkspaceManager(path.join(root, "temp"), path.join(root, "archive"));
    const worker = await manager.create(source, "o1", "t1", ["src/a.ts"]);
    await writeFile(path.join(worker.path, "src", "a.ts"), "changed\n");
    await writeFile(path.join(worker.path, "src", "b.ts"), "outside\n");
    await writeFile(path.join(worker.path, "tsconfig.tsbuildinfo"), "generated compiler cache\n");
    const changes = await manager.changes(worker);
    expect(changes.changedFiles).not.toContain("tsconfig.tsbuildinfo");
    expect(scopeViolations(changes, worker.allowedPaths)).toEqual(["src/b.ts"]);
    expect(await readFile(path.join(source, "src", "a.ts"), "utf8")).toBe("a\n");
    expect(await manager.cleanup(worker, "clean")).toEqual({ status: "cleaned", path: null });
  });

  it("repairs one malformed role response and uses distinct execution IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-role-"));
    temporary.push(root);
    const sink = new MemorySink();
    const seen: string[] = [];
    const outputs = ["not json", '{"ok":true}'];
    const runner: AgentRunner = {
      async run(request) {
        seen.push(request.executionId);
        const output = outputs.shift()!;
        return {
          output,
          threadId: null,
          usage: { inputTokens: 2, outputTokens: 1 },
          modelId: output.startsWith("{") ? "fallback-model" : request.modelId,
          modelFallback: output.startsWith("{"),
        };
      },
      async cancel() { return true; },
      async isAvailable() { return true; },
    };
    const roles = new RoleExecutor(runner, sink, { planner: "p", worker: "w", verifier: "v", integrator: "i" }, path.join(root, "homes"));
    const result = await roles.structured({
      orchestrationId: "o1", agentId: "a1", taskId: null, role: "planner",
      workspacePath: root, prompt: "json", sandboxMode: "read-only",
      signal: new AbortController().signal,
    }, z.object({ ok: z.boolean() }));
    expect(result.value.ok).toBe(true);
    expect(result).toMatchObject({ requestedModelId: "p", actualModelId: "fallback-model", modelFallback: true });
    expect(new Set(seen).size).toBe(2);
    expect(sink.usage).toHaveLength(2);
    expect(sink.events.filter((event) => event.type === "role-call-started")).toHaveLength(2);
  });

  it("sends the exact schema and reports safe field errors after a failed repair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-schema-"));
    temporary.push(root);
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run(request) { prompts.push(request.prompt); return { output: '{"wrong":true}', threadId: null, usage: null, modelId: request.modelId }; },
      async cancel() { return true; },
      async isAvailable() { return true; },
    };
    const roles = new RoleExecutor(runner, new MemorySink(), { planner: "p", worker: "w", verifier: "v", integrator: "i" }, path.join(root, "homes"));
    await expect(roles.structured({ orchestrationId: "o", agentId: "a", taskId: null, role: "planner", workspacePath: root, prompt: "plan", sandboxMode: "read-only", signal: new AbortController().signal }, z.object({ tasks: z.array(z.string()) })))
      .rejects.toThrow(/remained invalid after one repair: tasks:/);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Required JSON Schema");
    expect(prompts[1]).toContain('"tasks"');
    expect(prompts.join(" ")).not.toContain("protected evaluator");
  });

  it("supplies the complete invalid response to structured-output repair", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-complete-repair-"));
    temporary.push(root);
    const marker = "COMPLETE_PLAN_TAIL_MARKER";
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run(request) {
        prompts.push(request.prompt);
        return {
          output: prompts.length === 1
            ? JSON.stringify({ padding: "x".repeat(9_000) + marker })
            : JSON.stringify({ ok: request.prompt.includes(marker) }),
          threadId: null,
          usage: null,
          modelId: request.modelId,
        };
      },
      async cancel() { return true; },
      async isAvailable() { return true; },
    };
    const roles = new RoleExecutor(
      runner,
      new MemorySink(),
      { planner: "p", worker: "w", verifier: "v", integrator: "i" },
      path.join(root, "homes"),
    );

    const result = await roles.structured({
      orchestrationId: "o",
      agentId: "a",
      taskId: null,
      role: "planner",
      workspacePath: root,
      prompt: "plan",
      sandboxMode: "read-only",
      signal: new AbortController().signal,
    }, z.object({ ok: z.boolean() }));

    expect(result.value.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(marker);
  });

  it("targets only stale artifact consumers and refreshes them", async () => {
    const sink = new MemorySink();
    const registry = new ArtifactRegistry(sink);
    const consumer = { id: "consumer", orchestrationId: "o1", title: "C", objective: "C", status: "ready" as const, dependsOn: [], allowedPaths: ["src"], acceptanceCriterionIds: [], requiredArtifactIds: ["api"], observedArtifactVersions: { api: 1 }, applicationMapVersion: 1, attemptCount: 0 };
    const unaffected = { ...consumer, id: "other", requiredArtifactIds: [] };
    await registry.publish({ id: "api", orchestrationId: "o1", producerTaskId: "producer", kind: "api", name: "API", version: 1, payload: "v1", createdAt: "now" }, []);
    expect(await registry.publish({ id: "api", orchestrationId: "o1", producerTaskId: "producer", kind: "api", name: "API", version: 2, payload: "v2", createdAt: "now" }, [consumer, unaffected])).toEqual(["consumer"]);
    expect(consumer.status).toBe("stale");
    expect(unaffected.status).toBe("ready");
    await registry.refresh(consumer);
    expect(consumer.observedArtifactVersions.api).toBe(2);
  });

  it("keeps protected verification trusted and classifies compact failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-verify-"));
    temporary.push(root);
    const sink = new MemorySink();
    const service = new VerificationService(path.join(root, "protected"), [
      { id: "protected", description: "hidden acceptance", scope: "protected", run: async () => ({ passed: true, summary: "passed without source disclosure" }) },
      { id: "manual", description: "visual review", scope: "manual" },
    ], new Set());
    const records = await service.run("o1", null, root, ["protected", "manual"], sink, new AbortController().signal);
    expect(requiredVerificationPassed(records)).toBe(true);
    expect(requiredVerificationPassed([{
      id: "regression-not-applicable", orchestrationId: "o1", taskId: null,
      scope: "global", commandOrCheck: "Existing regression suite",
      status: "skipped", outputSummary: "No starting regression suite",
      startedAt: "now", completedAt: "now",
    }])).toBe(true);
    expect(JSON.stringify(records)).not.toContain(path.join(root, "protected"));
    const packet = createFailurePacket({ taskId: "t1", contractVersion: 1, attemptCount: 2, error: "token budget exhausted", verifications: [], changes: { changedFiles: [], deletedFiles: [], hashes: {} }, relevantInterfaces: [], diagnosis: "budget", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });
    expect(classifyFailure(packet)).toBe("budget-exhaustion");
    const infrastructurePacket = createFailurePacket({ taskId: "t1", contractVersion: 1, attemptCount: 2, error: "spawn /sbin/docker-init E2BIG: argument list too long", verifications: [], changes: { changedFiles: [], deletedFiles: [], hashes: {} }, relevantInterfaces: [], diagnosis: "container launch failed", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } });
    expect(classifyFailure(infrastructurePacket)).toBe("infrastructure-failure");
  });

  it("integrates non-conflicting files and detects main-workspace drift before publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-integrate-"));
    temporary.push(root);
    const main = path.join(root, "main");
    await mkdir(path.join(main, "src"), { recursive: true });
    await writeFile(path.join(main, "src", "base.ts"), "base\n");
    const manager = new WorkerWorkspaceManager(path.join(root, "temp"), path.join(root, "archive"));
    const one = await manager.create(main, "o1", "one", ["src/a.ts"]);
    await writeFile(path.join(one.path, "src", "a.ts"), "a\n");
    const two = await manager.create(main, "o1", "two", ["src/b.ts"]);
    await writeFile(path.join(two.path, "src", "b.ts"), "b\n");
    const integrator = new DeterministicIntegrator(path.join(root, "temp"));
    const candidate = await integrator.integrate("o1", main, [
      { taskId: "one", workspacePath: one.path, changes: await manager.changes(one) },
      { taskId: "two", workspacePath: two.path, changes: await manager.changes(two) },
    ]);
    expect(candidate.conflicts).toEqual([]);
    await writeFile(path.join(main, "src", "a.ts"), "user change\n");
    await expect(integrator.publish(candidate, main)).rejects.toThrow("workspace changed");
  });

  it("publishes an empty integration candidate as a no-op", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-empty-integrate-"));
    temporary.push(root);
    const main = path.join(root, "main");
    await mkdir(main, { recursive: true });
    await writeFile(path.join(main, "README.md"), "base\n");
    const integrator = new DeterministicIntegrator(path.join(root, "temp"));
    const candidate = await integrator.integrate("empty", main, []);
    await expect(integrator.publish(candidate, main)).resolves.toEqual([]);
    expect(await readFile(path.join(main, "README.md"), "utf8")).toBe("base\n");
  });

  it("gives the integrator only focused conflicting file variants", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-conflict-"));
    temporary.push(root);
    const main = path.join(root, "main");
    await mkdir(path.join(main, "src"), { recursive: true });
    await writeFile(path.join(main, "src", "shared.ts"), "base\n");
    const manager = new WorkerWorkspaceManager(path.join(root, "temp"), path.join(root, "archive"));
    const one = await manager.create(main, "o2", "one", ["src/shared.ts"]);
    const two = await manager.create(main, "o2", "two", ["src/shared.ts"]);
    await writeFile(path.join(one.path, "src", "shared.ts"), "one\n");
    await writeFile(path.join(two.path, "src", "shared.ts"), "two\n");
    const seen: string[] = [];
    const candidate = await new DeterministicIntegrator(path.join(root, "temp")).integrate(
      "o2",
      main,
      [
        { taskId: "one", workspacePath: one.path, changes: await manager.changes(one) },
        { taskId: "two", workspacePath: two.path, changes: await manager.changes(two) },
      ],
      async (conflict) => {
        seen.push(conflict.path, ...conflict.variants.map((variant) => variant.taskId));
        return Buffer.from("resolved\n");
      },
    );
    expect(seen).toEqual(["src/shared.ts", "one", "two"]);
    expect(await readFile(path.join(candidate.path, "src", "shared.ts"), "utf8")).toBe("resolved\n");
  });

  it("rejects a preflight that plans edits outside its task scope", () => {
    const task: OrchestrationTask = { id: "t", orchestrationId: "o", title: "t", objective: "t", status: "preflight", dependsOn: [], allowedPaths: ["src/a.ts"], acceptanceCriterionIds: ["c"], requiredArtifactIds: [], observedArtifactVersions: {}, applicationMapVersion: 1, attemptCount: 0 };
    const decision = reviewPreflight({ understanding: "x", expectedFiles: ["src/b.ts"], consumedArtifacts: [], publishedArtifacts: [], approach: ["edit"], missingContext: [], plannedChecks: ["test"] }, task, { id: "contract", orchestrationId: "o", version: 1, intent: { id: "i", orchestrationId: "o", revision: 1, goal: "g", requirements: ["r"], assumptions: [], nonGoals: [], architectureDecisions: [], materialQuestions: [], manualExpectations: [], createdAt: "now" }, criteria: [{ id: "c", kind: "functional", description: "works", verification: "visible-test" }], confirmedBy: "user", confirmedAt: "now", supersedesContractId: null });
    expect(decision.approved).toBe(false);
    const invalidContext = reviewPreflight({ understanding: "x", expectedFiles: ["src/a.ts"], consumedArtifacts: [], publishedArtifacts: [], approach: ["edit"], missingContext: [{ path: "/workspace", reason: "need root" }], plannedChecks: ["test"] }, task, { id: "contract", orchestrationId: "o", version: 1, intent: { id: "i", orchestrationId: "o", revision: 1, goal: "g", requirements: ["r"], assumptions: [], nonGoals: [], architectureDecisions: [], materialQuestions: [], manualExpectations: [], createdAt: "now" }, criteria: [{ id: "c", kind: "functional", description: "works", verification: "visible-test" }], confirmedBy: "user", confirmedAt: "now", supersedesContractId: null }, ["src/a.ts"]);
    expect(invalidContext.reason).toContain("invalid or unavailable context paths: /workspace");
  });
});
