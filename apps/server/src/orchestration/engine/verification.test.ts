import { describe, expect, it } from "vitest";
import { allPassed, createTrustedCommandRunner, runChecks, type CheckDefinition } from "./verification.js";
import { createInMemorySink } from "./test-doubles.js";

describe("runChecks / allPassed", () => {
  it("records a VerificationRecord via the sink for every check, whether it passes or fails", async () => {
    const sink = createInMemorySink();
    const checks: CheckDefinition[] = [
      { name: "typecheck", scope: "worker-visible" },
      { name: "protected-suite", scope: "protected" },
    ];
    const records = await runChecks("orch-1", "task-1", checks, "/workspaces/agent-1", async (check) => {
      return check.name === "typecheck"
        ? { status: "passed", outputSummary: "ok" }
        : { status: "failed", outputSummary: "assertion failed" };
    }, sink);

    expect(records).toHaveLength(2);
    expect(sink.verifications).toHaveLength(2);
    expect(allPassed(records)).toBe(false);
    expect(records.find((r) => r.commandOrCheck === "protected-suite")?.scope).toBe("protected");
  });

  it("allPassed is true only when every check passed", async () => {
    const sink = createInMemorySink();
    const records = await runChecks(
      "orch-1",
      null,
      [{ name: "a", scope: "global" }, { name: "b", scope: "global" }],
      "/w",
      async () => ({ status: "passed", outputSummary: "ok" }),
      sink,
    );
    expect(allPassed(records)).toBe(true);
  });
});

describe("createTrustedCommandRunner", () => {
  it("only runs a command that is in the trusted allowlist, by name — never an arbitrary string", async () => {
    const runner = createTrustedCommandRunner([{ name: "node-version", command: process.execPath, args: ["--version"] }]);
    const passed = await runner({ name: "node-version", scope: "global" }, process.cwd());
    expect(passed.status).toBe("passed");
    expect(passed.outputSummary).toMatch(/^v\d+\./);

    const skipped = await runner({ name: "not-configured", scope: "global" }, process.cwd());
    expect(skipped.status).toBe("skipped");
  });

  it("reports a non-zero exit as failed, with bounded output", async () => {
    const runner = createTrustedCommandRunner([
      { name: "fail", command: process.execPath, args: ["-e", "process.exit(1)"] },
    ]);
    const outcome = await runner({ name: "fail", scope: "global" }, process.cwd());
    expect(outcome.status).toBe("failed");
  });
});
