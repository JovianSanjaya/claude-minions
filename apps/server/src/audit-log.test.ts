import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "./types.js";
import { AuditLog, AuditedAgentRunner, createOrchestrationAuditObserver } from "./audit-log.js";
import { OrchestrationStore } from "./orchestration/control/store.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(maximumBytes = 25_000_000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-audit-"));
  temporary.push(directory);
  const audit = new AuditLog({ directory, maximumBytes, maximumFiles: 2 });
  await audit.initialize();
  return { directory, audit };
}

describe("AuditLog", () => {
  it("writes redacted global and per-orchestration JSONL timelines", async () => {
    const { audit } = await fixture();
    await audit.write({
      category: "orchestration", action: "worker-step", outcome: "info",
      orchestrationId: "orch-1", taskId: "task-1", executionId: "exec-1",
      agentId: "agent-1", durationMs: 12,
      data: { authorization: "Bearer secret", message: "ARK_API_KEY=very-secret-value" },
    });

    const entries = await audit.readOrchestration("orch-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "worker-step", taskId: "task-1" });
    const serialized = await readFile(audit.globalPath, "utf8");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("very-secret-value");
    expect(await readFile(audit.orchestrationPath("orch-1"), "utf8")).toBe(serialized);
  });

  it("rotates bounded log files", async () => {
    const { audit } = await fixture(400);
    for (let index = 0; index < 5; index += 1) {
      await audit.write({
        category: "system", action: "large", outcome: "info",
        orchestrationId: null, taskId: null, executionId: null, agentId: null,
        durationMs: null, data: { index, detail: "x".repeat(250) },
      });
    }
    expect((await stat(`${audit.globalPath}.1`)).isFile()).toBe(true);
    expect((await stat(`${audit.globalPath}.2`)).isFile()).toBe(true);
  });

  it("captures every persisted orchestration event through the store observer", async () => {
    const { directory, audit } = await fixture();
    const store = new OrchestrationStore(
      path.join(directory, "orchestrations.json"),
      undefined,
      createOrchestrationAuditObserver(audit),
    );
    await store.initialize();
    await store.mutate((database) => {
      database.events.push({
        id: "event-1", orchestrationId: "orch-2", taskId: null, executionId: null,
        type: "verification-profile-selected", actorRole: "control-plane", modelId: null,
        summary: "Selected fast verification", metadata: { profile: "fast" },
        createdAt: new Date().toISOString(),
      });
    });
    expect(await audit.readOrchestration("orch-2")).toEqual([
      expect.objectContaining({
        action: "verification-profile-selected",
        data: expect.objectContaining({ summary: "Selected fast verification" }),
      }),
    ]);
  });

  it("audits model execution without copying prompts or outputs into the log", async () => {
    const { audit } = await fixture();
    const inner: AgentRunner = {
      run: vi.fn().mockResolvedValue({
        output: "private model output", threadId: "thread-1",
        usage: { inputTokens: 100, outputTokens: 20 }, modelId: "model-1",
      }),
      cancel: vi.fn().mockResolvedValue(true),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const runner = new AuditedAgentRunner(inner, audit, (() => {
      let now = 100;
      return () => (now += 10);
    })());
    await runner.run({
      executionId: "exec-2", agentId: "agent-2", orchestrationId: "orch-3",
      taskId: "task-2", role: "worker", workspacePath: "/tmp/workspace",
      prompt: "private prompt", threadId: null,
    });

    const entries = await audit.readOrchestration("orch-3");
    expect(entries.map((entry) => entry.outcome)).toEqual(["started", "completed"]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private model output");
    expect(entries[1]?.data).toMatchObject({
      outputCharacters: 20,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });
});
