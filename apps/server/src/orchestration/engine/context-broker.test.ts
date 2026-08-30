import { describe, expect, it } from "vitest";
import type { ApplicationMap } from "./application-map.js";
import { buildContextPacket, resolveExpansion } from "./context-broker.js";

function fakeMap(): ApplicationMap {
  return {
    summary: {
      orchestrationId: "orch-1",
      version: 2,
      repositoryHash: "hash",
      summary: "",
      fileCount: 3,
      createdAt: new Date().toISOString(),
    },
    files: [
      { path: "src/auth/reset.ts", sha256: "h1", bytes: 400, imports: [], exports: ["requestReset"] },
      { path: "src/auth/token.ts", sha256: "h2", bytes: 200, imports: [], exports: ["issueToken"] },
      { path: "src/billing/invoice.ts", sha256: "h3", bytes: 900, imports: [], exports: ["createInvoice"] },
    ],
    directories: ["src", "src/auth", "src/billing"],
  };
}

describe("buildContextPacket", () => {
  it("includes only files under the task's allowed paths (minimum-sufficient, not repository-wide)", () => {
    const packet = buildContextPacket("task-1", fakeMap(), 1, ["src/auth"], {});
    expect(packet.files.map((file) => file.path)).toEqual(["src/auth/reset.ts", "src/auth/token.ts"]);
    expect(packet.summary.sourceFiles).toHaveLength(2);
    expect(packet.summary.relevantInterfaces.sort()).toEqual(["issueToken", "requestReset"]);
    expect(packet.summary.applicationMapVersion).toBe(2);
    expect(packet.summary.contractVersion).toBe(1);
  });

  it("never duplicates full source content into the packet — only paths, hashes, and byte counts", () => {
    const packet = buildContextPacket("task-1", fakeMap(), 1, ["src/billing"], {});
    for (const file of packet.summary.sourceFiles) {
      expect(Object.keys(file).sort()).toEqual(["bytes", "path", "sha256"]);
    }
  });

  it("carries artifact versions through for dependency-drift awareness", () => {
    const packet = buildContextPacket("task-1", fakeMap(), 1, ["src/auth"], { "shared-schema": 3 });
    expect(packet.summary.artifactVersions).toEqual({ "shared-schema": 3 });
  });
});

describe("resolveExpansion", () => {
  it("allows a narrow, in-workspace expansion request", () => {
    const decision = resolveExpansion("/workspaces/agent-1", { requestedPath: "src/shared/types.ts", reason: "need the interface" }, 0, 3);
    expect(decision.allowed).toBe(true);
  });

  it("blocks a path-traversal escape attempt", () => {
    const decision = resolveExpansion("/workspaces/agent-1", { requestedPath: "../../etc/passwd", reason: "x" }, 0, 3);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/escapes/i);
  });

  it("blocks a protected path such as .env or .git", () => {
    const envDecision = resolveExpansion("/workspaces/agent-1", { requestedPath: ".env", reason: "x" }, 0, 3);
    expect(envDecision.allowed).toBe(false);
    const gitDecision = resolveExpansion("/workspaces/agent-1", { requestedPath: ".git/config", reason: "x" }, 0, 3);
    expect(gitDecision.allowed).toBe(false);
  });

  it("enforces the per-task expansion budget", () => {
    const decision = resolveExpansion("/workspaces/agent-1", { requestedPath: "src/x.ts", reason: "x" }, 3, 3);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/budget/i);
  });
});
