import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildCodexArgs,
  CodexRunner,
  consumeCodexOutputChunk,
  parseCodexEventLine,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        executionId: "execution-1",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "-",
    ]);
    expect(args).not.toContain("build a calculator");
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        executionId: "execution-2",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "-"]);
    expect(args).not.toContain("add tests");
  });

  it("passes a trusted role model override as an argv element", () => {
    const args = buildCodexArgs(
      {
        executionId: "execution-model",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "plan",
        threadId: null,
        role: "planner",
        modelId: "trusted-model-id",
        sandboxMode: "read-only",
      },
      "read-only",
    );
    expect(args).toContain("trusted-model-id");
    expect(args.slice(-3)).toEqual(["--model", "trusted-model-id", "-"]);
    expect(args).not.toContain("plan");
  });

  it("truthfully omits unsupported model overrides", () => {
    const args = buildCodexArgs(
      {
        executionId: "execution-fallback",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "work",
        threadId: null,
        modelId: "requested-role-model",
      },
      "workspace-write",
      "/tmp/workspace",
      false,
    );
    expect(args).not.toContain("requested-role-model");
  });

  it("streams a large prompt through stdin instead of process arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-stdin-"));
    const executable = path.join(root, "fake-codex.sh");
    await writeFile(executable, [
      "#!/bin/sh",
      "prompt=$(cat)",
      "bytes=$(printf %s \"$prompt\" | wc -c | tr -d ' ')",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"stdin-thread\"}'",
      "printf '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"stdin-bytes:%s\"}}\\n' \"$bytes\"",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}'",
    ].join("\n"));
    await chmod(executable, 0o700);
    try {
      const runner = new CodexRunner(loadConfig({
        NODE_ENV: "test",
        CODEX_BIN: executable,
        CODEX_TIMEOUT_MS: "10000",
      }));
      const prompt = "x".repeat(512_000);
      const result = await runner.run({
        executionId: "large-prompt",
        agentId: "agent",
        workspacePath: root,
        prompt,
        threadId: null,
      });

      expect(result.output).toBe(`stdin-bytes:${prompt.length}`);
      expect(result.threadId).toBe("stdin-thread");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("tail-caps diagnostic stderr without charging it to the stdout result limit", () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const accumulator = { stdoutBuffer: "", stderrTail: "", stdoutBytes: 0 };
    const noisyDiagnostic = Buffer.from("ReasoningSummaryDelta without active item\n".repeat(1_000));

    expect(consumeCodexOutputChunk(accumulator, noisyDiagnostic, "stderr", 128, parsed)).toBe(false);
    expect(accumulator.stdoutBytes).toBe(0);
    expect(accumulator.stderrTail.length).toBeLessThanOrEqual(16_384);

    const event = Buffer.from(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Done." },
    }) + "\n");
    expect(consumeCodexOutputChunk(accumulator, event, "stdout", 256, parsed)).toBe(false);
    expect(parsed.messages).toEqual(["Done."]);
    expect(consumeCodexOutputChunk(accumulator, Buffer.alloc(257), "stdout", 256, parsed)).toBe(true);
  });
});
