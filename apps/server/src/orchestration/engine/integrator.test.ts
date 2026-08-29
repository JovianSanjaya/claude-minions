import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BudgetDecision,
  ExecutionContract,
  ModelCallReservation,
  OrchestrationEvent,
  OrchestrationSink,
  OrchestrationTask,
  TokenUsage,
  VerificationRecord,
} from "../contracts.js";
import type { AgentRunner, RunnerRequest } from "../../types.js";
import { ApplicationMapBuilder } from "./application-map.js";
import { Integrator } from "./integrator.js";
import { RoleExecutor } from "./role-executor.js";
import { VerificationService, type VerificationExecutor } from "./verification.js";
import { WorkerWorkspaceManager } from "./worker-workspaces.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic-first integrator", () => {
  it("gives only conflicting files to the model and publishes after global verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "integrator-"));
    roots.push(root);
    const main = path.join(root, "main");
    await mkdir(main, { recursive: true });
    await writeFile(path.join(main, "shared.ts"), "export const value = 1;\n");
    const map = await new ApplicationMapBuilder().build("orch", main);
    const manager = new WorkerWorkspaceManager(path.join(root, "temp"), path.join(root, "archive"));
    const makeTask = (id: string): OrchestrationTask => ({
      id,
      orchestrationId: "orch",
      title: id,
      objective: id,
      status: "passed",
      dependsOn: [],
      allowedPaths: ["shared.ts"],
      acceptanceCriterionIds: ["c1"],
      requiredArtifactIds: [],
      observedArtifactVersions: {},
      applicationMapVersion: 1,
      attemptCount: 1,
    });
    const leftTask = makeTask("left");
    const rightTask = makeTask("right");
    const left = await manager.create("orch", leftTask, map, ["shared.ts"]);
    const right = await manager.create("orch", rightTask, map, ["shared.ts"]);
    await writeFile(path.join(left.workspacePath, "shared.ts"), "export const value = 2;\n");
    await writeFile(path.join(right.workspacePath, "shared.ts"), "export const value = 3;\n");
    const prompts: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        prompts.push(request);
        expect(request.prompt).toContain("Conflict: shared.ts");
        expect(request.prompt).not.toContain("unrelated.ts");
        await writeFile(path.join(request.workspacePath, "shared.ts"), "export const value = 4;\n");
        return { output: "Resolved the focused conflict", threadId: null, usage: null, modelId: "integrator" };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const events: Array<Omit<OrchestrationEvent, "id" | "createdAt">> = [];
    const verifications: VerificationRecord[] = [];
    const sink = {
      reserveModelCall: async (_input: ModelCallReservation): Promise<BudgetDecision> => ({ allowed: true, reservationId: "r" }),
      commitModelUsage: async (_id: string, _usage: TokenUsage) => undefined,
      recordEvent: async (event: Omit<OrchestrationEvent, "id" | "createdAt">) => void events.push(event),
      recordVerification: async (record: VerificationRecord) => void verifications.push(record),
      recordApplicationMap: async () => undefined,
    } as unknown as OrchestrationSink;
    const roles = new RoleExecutor({
      runner,
      models: { planner: "planner", worker: "worker", verifier: "verifier", integrator: "integrator" },
      baseModelId: "base",
      modelOverrideSupported: true,
      runtimeHomeRoot: path.join(root, "homes"),
      idProvider: () => "integrate-1",
    });
    const verifier: VerificationExecutor = {
      execute: async () => ({ exitCode: 0, stdout: "global pass", stderr: "" }),
    };
    const verification = new VerificationService(
      path.join(root, "protected"),
      [{ id: "global", scope: "global", command: "trusted", args: [], cwd: "workspace" }],
      verifier,
    );
    const integrator = new Integrator(roles, manager, verification);
    const timestamp = new Date().toISOString();
    const contract = {
      id: "contract",
      orchestrationId: "orch",
      version: 1,
      intent: {
        id: "intent",
        orchestrationId: "orch",
        revision: 1,
        goal: "Resolve",
        requirements: [],
        assumptions: [],
        nonGoals: [],
        architectureDecisions: [],
        materialQuestions: [],
        manualExpectations: [],
        createdAt: timestamp,
      },
      criteria: [{ id: "c1", kind: "functional", description: "resolved", verification: "static-check" }],
      confirmedBy: "user",
      confirmedAt: timestamp,
      supersedesContractId: null,
    } satisfies ExecutionContract;
    const result = await integrator.integrate({
      orchestrationId: "orch",
      agentId: "agent",
      contract,
      map,
      workers: [
        { task: leftTask, workspace: left, manifest: await manager.inspect(left) },
        { task: rightTask, workspace: right, manifest: await manager.inspect(right) },
      ],
      sink,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("published");
    expect(await readFile(path.join(main, "shared.ts"), "utf8")).toContain("4");
    expect(prompts).toHaveLength(1);
    expect(events.find((event) => event.type === "integration.candidate-ready")?.metadata.conflicts).toBe(1);
    expect(verifications.some((record) => record.scope === "global")).toBe(true);
  });
});
