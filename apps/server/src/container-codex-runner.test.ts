import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("generates low-latency provider config without reasoning summaries", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "launchpad-codex-config-"));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        ARK_MODEL: "ep-test",
        CODEX_HOME: home,
      });
      await writeCodexConfig(config);
      const contents = await readFile(path.join(home, "config.toml"), "utf8");
      expect(contents).toContain('model_reasoning_effort = "low"');
      expect(contents).toContain('model_reasoning_summary = "none"');
      expect(contents).toContain("model_supports_reasoning_summaries = false");
      expect(contents).toContain("request_max_retries = 3");
      expect(contents).toContain("stream_max_retries = 3");
      expect(contents).toContain("stream_idle_timeout_ms = 180000");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        executionId: "execution/unsafe",
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        orchestrationId: "orch-1",
        taskId: "task-1",
        runtimeHomePath: "/tmp/role-home",
        sandboxMode: "read-only",
      },
      config,
    );

    expect(containerName("execution/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-execution-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("--interactive");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace,readonly");
    expect(args).toContain("type=bind,src=/tmp/role-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("danger-full-access");
    expect(args).not.toContain("read-only");
    expect(args).toContain("--read-only");
    expect(args).toContain("/tmp:rw,nosuid,nodev,size=512m,mode=1777");
    expect(args).toContain("256m");
    expect(args).toContain("TMPDIR=/tmp");
    expect(args).toContain("XDG_RUNTIME_DIR=/tmp/runtime");
    expect(args).toContain("CHROME_BIN=/usr/bin/chromium");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("io.codejam.execution-id=execution/unsafe");
    expect(args).toContain("io.codejam.orchestration-id=orch-1");
    expect(args).toContain("io.codejam.task-id=task-1");
    expect(args).toContain("io.codejam.runtime-profile=default");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("labels browser-capable verification without making the candidate writable", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_TMPFS_SIZE: "768m",
      CONTAINER_SHM_SIZE: "384m",
    });
    const args = buildContainerRunArgs({
      executionId: "verify-execution",
      agentId: "agent",
      workspacePath: "/tmp/candidate",
      prompt: "verify",
      threadId: null,
      role: "verifier",
      sandboxMode: "read-only",
      runtimeProfile: "verification",
    }, config);

    expect(args).toContain("io.codejam.runtime-profile=verification");
    expect(args).toContain("type=bind,src=/tmp/candidate,dst=/workspace,readonly");
    expect(args).toContain("/tmp:rw,nosuid,nodev,size=768m,mode=1777");
    expect(args).toContain("384m");
    expect(args).toContain("bridge");
  });

  it("uses the outer container as the writable sandbox boundary", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs({
      executionId: "write-execution",
      agentId: "agent",
      workspacePath: "/tmp/workspace",
      prompt: "write index.html",
      threadId: null,
      sandboxMode: "workspace-write",
    }, config);
    expect(args).toContain("type=bind,src=/tmp/workspace,dst=/workspace");
    expect(args).not.toContain("type=bind,src=/tmp/workspace,dst=/workspace,readonly");
    expect(args).toContain("danger-full-access");
    expect(args).not.toContain("workspace-write");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        executionId: "execution-2",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "-"]);
    expect(args).not.toContain("continue");
    expect(args).not.toContain("keep-id");
  });
});
