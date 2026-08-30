import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type {
  AgentExecutionCoordinator,
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { RunCancelledError, RunFailedError } from "./errors.js";
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
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    coordinator,
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

  it("uses the Run ID as the exact direct execution and cancellation key", async () => {
    let rejectRun!: (error: Error) => void;
    let seenExecutionId = "";
    let cancelledExecutionId = "";
    const runner: AgentRunner = {
      run: (request) => {
        seenExecutionId = request.executionId;
        return new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        });
      },
      cancel: async (executionId) => {
        cancelledExecutionId = executionId;
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Exact cancellation" });
    const { run } = await service.sendMessage(agent.id, "long task");
    await expect.poll(() => seenExecutionId).toBe(run.id);
    await service.stopAgent(agent.id);
    expect(cancelledExecutionId).toBe(run.id);
    expect(service.getRun(run.id).status).toBe("cancelled");
  });

  it("keeps the Codex thread a timed-out or failed run reported so continuing preserves context", async () => {
    const runner: AgentRunner = {
      run: async () => {
        throw new RunFailedError("Codex timed out after 1800000 ms", "thread-from-failed-turn");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Times out" });
    const { run } = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getAgent(agent.id).codexThreadId).toBe("thread-from-failed-turn");
  });

  it("leaves the prior Codex thread untouched when a failure reports no thread id", async () => {
    let attempt = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        attempt += 1;
        if (attempt === 1) return { output: "seeded", threadId: "established-thread", usage: null };
        throw new RunFailedError("Codex exited with code 1: boom", null);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Second turn fails" });
    const { run: firstRun } = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(firstRun.id).status).toBe("completed");
    expect(service.getAgent(agent.id).codexThreadId).toBe("established-thread");

    const { run: secondRun } = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(secondRun.id).status).toBe("failed");
    expect(service.getAgent(agent.id).codexThreadId).toBe("established-thread");
  });

  it("coordinates direct admission and Agent stop/delete with orchestration", async () => {
    const calls: string[] = [];
    let deny = true;
    const coordinator: AgentExecutionCoordinator = {
      assertAgentAvailableForDirect: async (agentId) => {
        calls.push(`assert:${agentId}`);
        if (deny) throw Object.assign(new Error("orchestration active"), { statusCode: 409 });
      },
      hasActiveOrchestration: () => deny,
      cancelForAgent: async (agentId) => {
        calls.push(`cancel:${agentId}`);
        deny = false;
        return true;
      },
    };
    const service = await makeService(new FakeRunner(), coordinator);
    const first = await service.createAgent({ name: "Coordinated" });
    await expect(service.sendMessage(first.id, "blocked")).rejects.toMatchObject({ statusCode: 409 });
    await service.stopAgent(first.id);
    expect(calls).toContain(`cancel:${first.id}`);
    const second = await service.createAgent({ name: "Delete coordinated" });
    await service.deleteAgent(second.id);
    expect(calls).toContain(`cancel:${second.id}`);
  });
});
