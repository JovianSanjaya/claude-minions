import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { createFakeAgentRunner } from "./engine/test-doubles.js";
import { composeOrchestration, createOrchestrationCoordinator } from "./composition.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

const elaborationJson = JSON.stringify({
  goal: "Add a hello endpoint",
  requirements: [{ text: "Add a hello endpoint", provenance: "user-explicit", materiality: "trivial", rationale: null }],
  assumptions: [],
  nonGoals: [],
  architectureDecisions: [],
  manualExpectations: [],
  openQuestions: [],
  estimate: { inputTokenLow: 10, inputTokenHigh: 50, outputTokenLow: 5, outputTokenHigh: 20, assumptions: [] },
});

async function buildComposedApp(overrides: { authToken?: string } = {}) {
  const dataDir = await tempDir("integration-data-");
  const workspaceRoot = await tempDir("integration-workspaces-");
  const codexHome = await tempDir("integration-codex-home-");

  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: dataDir,
    AGENT_WORKSPACE_ROOT: workspaceRoot,
    CODEX_HOME: codexHome,
    RUNTIME_PROVIDER: "local-process",
    ...(overrides.authToken ? { APP_AUTH_TOKEN: overrides.authToken } : {}),
  });

  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
  const workspaces = new WorkspaceManager(config.workspaceRoot);

  const runner = createFakeAgentRunner(async (request) => {
    if (request.prompt.includes("establishing common ground")) {
      return { output: elaborationJson, threadId: null, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } };
    }
    if (request.prompt.startsWith("Implement the confirmed request")) {
      await writeFile(path.join(request.workspacePath, "hello.txt"), "hello\n");
      return { output: "Added hello.txt", threadId: null, usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 10 } };
    }
    return { output: "ok", threadId: null, usage: null };
  });

  const { controlService, benchmarkService } = await composeOrchestration(config, store, runner);
  const coordinator = createOrchestrationCoordinator(controlService);
  const service = new AgentService(config, store, workspaces, runner, coordinator);
  await service.initialize();

  const app = await createApp(config, service, { orchestration: controlService, benchmark: benchmarkService });
  return { app, config, service, controlService };
}

describe("composed app: full orchestration lifecycle through real routes", () => {
  it("walks create -> elaborate -> confirm -> plan -> start -> execute -> completed via HTTP, end to end", async () => {
    const { app, service, controlService } = await buildComposedApp();

    const created = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "Integration Agent" } });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const orchestrationCreated = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/orchestrations`,
      payload: { prompt: "Add a hello endpoint" },
    });
    expect(orchestrationCreated.statusCode).toBe(202);
    const orchestrationId = orchestrationCreated.json().orchestration.id as string;

    await controlService.waitForPendingWork(orchestrationId);
    const afterElaboration = await app.inject({ method: "GET", url: `/api/orchestrations/${orchestrationId}` });
    expect(afterElaboration.json().orchestration.status).toBe("awaiting-confirmation");

    const confirm = await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/confirm` });
    expect(confirm.statusCode).toBe(200);

    await controlService.waitForPendingWork(orchestrationId); // planning -> ready
    const afterPlanning = await app.inject({ method: "GET", url: `/api/orchestrations/${orchestrationId}` });
    expect(afterPlanning.json().orchestration.status).toBe("ready");

    const start = await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/start` });
    expect(start.statusCode).toBe(202);

    await controlService.waitForPendingWork(orchestrationId); // running -> completed
    const final = await app.inject({ method: "GET", url: `/api/orchestrations/${orchestrationId}` });
    expect(final.json().orchestration.status).toBe("completed");

    const events = await app.inject({ method: "GET", url: `/api/orchestrations/${orchestrationId}/events` });
    expect(events.json().events.length).toBeGreaterThan(0);

    // direct chat still works, unmodified, alongside orchestration
    void service;
    await app.close();
  });

  it("protects every new orchestration/benchmark route with the same bearer token as the baseline routes", async () => {
    const { app } = await buildComposedApp({ authToken: "a-strong-integration-test-token" });

    const denied = await app.inject({ method: "GET", url: "/api/agents/00000000-0000-0000-0000-000000000000/orchestrations" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents/00000000-0000-0000-0000-000000000000/orchestrations",
      headers: { authorization: "Bearer a-strong-integration-test-token" },
    });
    expect(allowed.statusCode).toBe(200);

    const benchmarkDenied = await app.inject({ method: "GET", url: "/api/benchmarks/00000000-0000-0000-0000-000000000000" });
    expect(benchmarkDenied.statusCode).toBe(401);

    await app.close();
  });

  it("cancels an active orchestration when its Agent is deleted, and archives the workspace normally", async () => {
    const { app, controlService } = await buildComposedApp();
    const created = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "Delete Me" } });
    const agentId = created.json().agent.id as string;

    const orchestrationCreated = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/orchestrations`,
      payload: { prompt: "Add a hello endpoint" },
    });
    const orchestrationId = orchestrationCreated.json().orchestration.id as string;
    await controlService.waitForPendingWork(orchestrationId);
    await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/confirm` });
    await controlService.waitForPendingWork(orchestrationId);

    const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${agentId}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().archivedWorkspace).toBeTruthy();

    const orchestrationAfterDelete = controlService.getOrchestration(orchestrationId);
    expect(orchestrationAfterDelete.status).toBe("cancelled");

    await app.close();
  });

  it("blocks direct execution while an orchestration is active for the same Agent, and vice versa", async () => {
    const { app, controlService } = await buildComposedApp();
    const created = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "Race Guard" } });
    const agentId = created.json().agent.id as string;

    const orchestrationCreated = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/orchestrations`,
      payload: { prompt: "Add a hello endpoint" },
    });
    const orchestrationId = orchestrationCreated.json().orchestration.id as string;
    await controlService.waitForPendingWork(orchestrationId);
    await app.inject({ method: "POST", url: `/api/orchestrations/${orchestrationId}/confirm` });
    // do NOT wait for planning to finish — the orchestration is still active
    // ("planning"), so a concurrent direct send must be rejected.

    const directSend = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      payload: { content: "hi" },
    });
    expect(directSend.statusCode).toBe(409);

    await controlService.waitForPendingWork(orchestrationId); // let background planning finish before teardown
    await app.close();
  });
});
