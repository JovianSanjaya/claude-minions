import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexArgs, CodexRunner, parseCodexEventLine } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        executionId: "run-1",
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
        executionId: "run-2",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
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

  it("allows concurrent execution IDs for one Agent and cancels only the requested child", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-runner-"));
    temporaryDirectories.push(root);
    const executable = path.join(root, "fake-codex");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) { console.log("fake 1.0"); process.exit(0); }',
        "const prompt = process.argv.at(-1);",
        "const finish = () => {",
        '  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-" + prompt }));',
        '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done-" + prompt } }));',
        "};",
        'setTimeout(finish, prompt === "slow" ? 5000 : 40);',
        'setTimeout(() => process.exit(0), prompt === "slow" ? 5050 : 60);',
        'process.on("SIGTERM", () => process.exit(143));',
      ].join("\n"),
      "utf8",
    );
    await chmod(executable, 0o755);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_BIN: executable,
      CODEX_HOME: path.join(root, "codex-home"),
      CODEX_TIMEOUT_MS: "10000",
    });
    const runner = new CodexRunner(config);
    const slow = runner
      .run({
        executionId: "execution-slow",
        agentId: "same-agent",
        workspacePath: root,
        prompt: "slow",
        threadId: null,
      })
      .then((value) => value, (error: unknown) => error);
    const fast = runner.run({
      executionId: "execution-fast",
      agentId: "same-agent",
      workspacePath: root,
      prompt: "fast",
      threadId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(runner.cancel("execution-slow")).resolves.toBe(true);
    await expect(fast).resolves.toMatchObject({ output: "done-fast" });
    await expect(slow).resolves.toBeInstanceOf(RunCancelledError);
    await expect(runner.cancel("execution-slow")).resolves.toBe(false);
  });
});
