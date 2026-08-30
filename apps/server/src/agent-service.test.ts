import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { HttpError } from "./errors.js";
import type {
  AgentExecutionCoordinator,
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  coordinator?: AgentExecutionCoordinator,
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = coordinator
    ? new AgentService(
        config,
        new JsonStore(path.join(root, "data", "db.json")),
        new WorkspaceManager(path.join(root, "workspaces")),
        runner,
        coordinator,
      )
    : new AgentService(
        config,
        new JsonStore(path.join(root, "data", "db.json")),
        new WorkspaceManager(path.join(root, "workspaces")),
        runner,
      );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("orchestration coordinator port", () => {
  it("keeps working when the coordinator is omitted and passes the Run ID as the execution ID", async () => {
    const seen: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        seen.push({ ...request });
        return { output: "ok", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Direct" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.executionId).toBe(run.id);
    expect(seen[0]?.agentId).toBe(agent.id);
    // The direct path stays exactly as it was: no orchestration metadata.
    expect(seen[0]?.orchestrationId).toBeUndefined();
    expect(seen[0]?.role).toBeUndefined();
    expect(seen[0]?.modelId).toBeUndefined();
    expect(seen[0]?.sandboxMode).toBeUndefined();
  });

  it("refuses a direct Run when the coordinator says orchestration owns the workspace", async () => {
    const calls: string[] = [];
    const coordinator: AgentExecutionCoordinator = {
      assertAgentAvailableForDirect: async (agentId) => {
        calls.push("assert:" + agentId);
        throw new HttpError(409, "An orchestration is using this Agent workspace");
      },
      hasActiveOrchestration: async () => true,
      cancelForAgent: async (agentId) => {
        calls.push("cancel:" + agentId);
      },
    };
    const service = await makeService(new FakeRunner(), coordinator);
    const agent = await service.createAgent({ name: "Coordinated" });

    await expect(service.sendMessage(agent.id, "hello")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(calls).toEqual(["assert:" + agent.id]);
    expect(service.getMessages(agent.id)).toHaveLength(0);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("cancels orchestration work when an Agent is stopped or deleted", async () => {
    const calls: string[] = [];
    const coordinator: AgentExecutionCoordinator = {
      assertAgentAvailableForDirect: async () => {},
      hasActiveOrchestration: async () => false,
      cancelForAgent: async (agentId) => {
        calls.push("cancel:" + agentId);
      },
    };
    const service = await makeService(new FakeRunner(), coordinator);
    const agent = await service.createAgent({ name: "Coordinated" });

    await service.stopAgent(agent.id);
    await service.startAgent(agent.id);
    await service.deleteAgent(agent.id);

    expect(calls).toEqual(["cancel:" + agent.id, "cancel:" + agent.id]);
  });

  it("cancels the exact active execution rather than the Agent ID", async () => {
    const cancelled: string[] = [];
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async (executionId) => {
        cancelled.push(executionId);
        finish({ output: "cancelled", threadId: null, usage: null });
        return true;
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Cancellable" });
    const { run } = await service.sendMessage(agent.id, "long task");

    await service.stopAgent(agent.id);
    expect(cancelled).toEqual([run.id]);
    expect(cancelled).not.toContain(agent.id);
  });
});
