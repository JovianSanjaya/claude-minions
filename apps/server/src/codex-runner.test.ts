import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  consumeCodexOutputChunk,
  parseCodexEventLine,
  CodexRunner,
} from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RunFailedError } from "./errors.js";

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
      "build a calculator",
    ]);
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
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
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
    expect(args.slice(-3)).toEqual(["--model", "trusted-model-id", "plan"]);
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

describe("CodexRunner.run", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("surfaces the thread id Codex reported even when the process exits non-zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-runner-test-"));
    temporaryDirectories.push(root);
    const fakeCodexBin = path.join(root, "fake-codex");
    await writeFile(
      fakeCodexBin,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-xyz' }) + '\\n');",
        "process.exitCode = 1;",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodexBin, 0o755);

    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      CODEX_BIN: fakeCodexBin,
    });
    const runner = new CodexRunner(config);
    const run = runner.run({
      executionId: "exec-thread-surface",
      agentId: "agent-1",
      workspacePath: root,
      prompt: "ignored",
      threadId: null,
    });
    await expect(run).rejects.toBeInstanceOf(RunFailedError);
    await expect(run).rejects.toMatchObject({ threadId: "thread-xyz" });
  });
});
