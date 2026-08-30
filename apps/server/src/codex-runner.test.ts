import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexRunner,
  buildCodexArgs,
  parseCodexEventLine,
  resolveSandboxMode,
} from "./codex-runner.js";
import { loadConfig } from "./config.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
        executionId: "run-1",
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
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
        executionId: "run-2",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("adds a trusted model override only when one is supplied", () => {
    const base = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "work",
      threadId: null,
      executionId: "exec-1",
    };
    expect(buildCodexArgs(base, "workspace-write")).not.toContain("--model");
    const overridden = buildCodexArgs(
      { ...base, modelId: "ep-worker" },
      "workspace-write",
    );
    expect(overridden).toContain("--model");
    expect(overridden[overridden.indexOf("--model") + 1]).toBe("ep-worker");
  });

  it("never escalates the configured sandbox mode", () => {
    const base = {
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "work",
      threadId: null,
      executionId: "exec-1",
    };
    expect(resolveSandboxMode(base, "workspace-write")).toBe("workspace-write");
    expect(resolveSandboxMode({ ...base, sandboxMode: "read-only" }, "danger-full-access"))
      .toBe("read-only");
    expect(
      resolveSandboxMode({ ...base, sandboxMode: "workspace-write" }, "danger-full-access"),
    ).toBe("workspace-write");
    expect(
      resolveSandboxMode({ ...base, sandboxMode: "workspace-write" }, "read-only"),
    ).toBe("read-only");
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
});

// ---------------------------------------------------------------------------
// Execution-ID keyed concurrency and exact cancellation.
//
// These tests spawn a small local stand-in for the Codex CLI, so they need no
// network, no Ark credentials, no Docker and no globally installed Codex.
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRunner(kind: "fast" | "slow"): Promise<{
  runner: CodexRunner;
  workspace: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-runner-"));
  temporaryDirectories.push(root);
  const script = path.join(root, "fake-codex.sh");
  const body =
    kind === "fast"
      ? [
          "#!/bin/sh",
          `echo '{"type":"thread.started","thread_id":"thread-x"}'`,
          `echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'`,
          `echo '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'`,
          "",
        ].join("\n")
      : ["#!/bin/sh", 'exec node -e "setTimeout(() => {}, 30000)"', ""].join("\n");
  await writeFile(script, body, "utf8");
  await chmod(script, 0o755);

  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    CODEX_BIN: script,
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  return { runner: new CodexRunner(config), workspace: root };
}

const request = (executionId: string, workspacePath: string) => ({
  agentId: "agent-1",
  workspacePath,
  prompt: "do the work",
  threadId: null,
  executionId,
});

describe("Codex runner execution isolation", () => {
  it("runs several executions for one Agent concurrently", async () => {
    const { runner, workspace } = await makeRunner("fast");
    const [first, second] = await Promise.all([
      runner.run(request("exec-a", workspace)),
      runner.run(request("exec-b", workspace)),
    ]);
    expect(first.output).toBe("done");
    expect(second.output).toBe("done");
    expect(first.threadId).toBe("thread-x");
    expect(first.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it("rejects a second call that reuses the same execution ID", async () => {
    const { runner, workspace } = await makeRunner("slow");
    const active = runner.run(request("exec-a", workspace));
    await expect(runner.run(request("exec-a", workspace))).rejects.toThrow(
      "Execution already has an active Codex process",
    );
    await runner.cancel("exec-a");
    await expect(active).rejects.toThrow("Run cancelled");
  });

  it("cancels exactly one execution and leaves the other running", async () => {
    const { runner, workspace } = await makeRunner("slow");
    const first = request("exec-a", workspace);
    const second = request("exec-b", workspace);
    const firstRun = runner.run(first);
    const secondRun = runner.run(second);
    let secondSettled = false;
    void secondRun.catch(() => undefined).finally(() => {
      secondSettled = true;
    });

    expect(await runner.cancel("exec-a")).toBe(true);
    await expect(firstRun).rejects.toThrow("Run cancelled");
    expect(secondSettled).toBe(false);

    expect(await runner.cancel("exec-b")).toBe(true);
    await expect(secondRun).rejects.toThrow("Run cancelled");
  });

  it("reports false when cancelling an execution that is not active", async () => {
    const { runner } = await makeRunner("fast");
    expect(await runner.cancel("unknown-execution")).toBe(false);
  });

  it("reports no model-override support when the Runtime does not advertise one", async () => {
    const { runner } = await makeRunner("fast");
    expect(await runner.supportsModelOverride()).toBe(false);
  });
});
