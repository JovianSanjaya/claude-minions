import { describe, expect, it } from "vitest";
import type { OrchestrationStatus } from "../contracts.js";
import {
  assertTransition,
  canTransition,
  completionPath,
  IllegalTransitionError,
  INTERRUPTIBLE_STATUSES,
  isTerminalStatus,
  LEGAL_TRANSITIONS,
  ORCHESTRATION_STATUSES,
  TERMINAL_STATUSES,
  WORKSPACE_ACTIVE_STATUSES,
} from "./state-machine.js";

/** The minimum transition set the specification requires, verbatim. */
const REQUIRED_TRANSITIONS: ReadonlyArray<[OrchestrationStatus, OrchestrationStatus]> = [
  ["drafting-intent", "awaiting-confirmation"],
  ["awaiting-confirmation", "drafting-intent"],
  ["awaiting-confirmation", "planning"],
  ["planning", "ready"],
  ["planning", "needs-user"],
  ["planning", "failed"],
  ["ready", "running"],
  ["running", "integrating"],
  ["running", "needs-user"],
  ["running", "budget-exhausted"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["integrating", "verifying"],
  ["integrating", "needs-user"],
  ["integrating", "failed"],
  ["integrating", "cancelled"],
  ["verifying", "completed"],
  ["verifying", "needs-user"],
  ["verifying", "failed"],
  ["verifying", "cancelled"],
  ["needs-user", "awaiting-confirmation"],
  ["needs-user", "planning"],
  ["needs-user", "cancelled"],
];

const ILLEGAL_TRANSITIONS: ReadonlyArray<[OrchestrationStatus, OrchestrationStatus]> = [
  ["drafting-intent", "planning"],
  ["drafting-intent", "ready"],
  ["awaiting-confirmation", "running"],
  ["awaiting-confirmation", "completed"],
  ["planning", "running"],
  ["ready", "completed"],
  ["ready", "integrating"],
  ["running", "completed"],
  ["integrating", "completed"],
  ["completed", "running"],
  ["failed", "running"],
  ["cancelled", "running"],
  ["budget-exhausted", "running"],
  ["budget-exhausted", "cancelled"],
];

describe("orchestration state machine", () => {
  it("covers every Appendix A status", () => {
    expect(ORCHESTRATION_STATUSES).toHaveLength(12);
    for (const status of ORCHESTRATION_STATUSES) {
      expect(LEGAL_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("allows every required transition", () => {
    for (const [from, to] of REQUIRED_TRANSITIONS) {
      expect(canTransition(from, to), from + " -> " + to).toBe(true);
    }
  });

  it("rejects representative illegal transitions with a typed conflict error", () => {
    for (const [from, to] of ILLEGAL_TRANSITIONS) {
      expect(canTransition(from, to), from + " -> " + to).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
    try {
      assertTransition("ready", "completed");
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).statusCode).toBe(409);
    }
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const status of ORCHESTRATION_STATUSES) {
      if (isTerminalStatus(status)) {
        continue;
      }
      expect(canTransition(status, "cancelled"), status).toBe(true);
    }
  });

  it("treats completed, failed, cancelled and budget-exhausted as terminal", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      "budget-exhausted",
      "cancelled",
      "completed",
      "failed",
    ]);
    for (const status of TERMINAL_STATUSES) {
      expect(LEGAL_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it("never reaches completed without passing through verification", () => {
    for (const status of ORCHESTRATION_STATUSES) {
      if (status === "verifying") {
        continue;
      }
      expect(canTransition(status, "completed"), status).toBe(false);
    }
  });

  it("describes the stage path used when the driver reports completion", () => {
    expect(completionPath("running")).toEqual(["integrating", "verifying", "completed"]);
    expect(completionPath("integrating")).toEqual(["verifying", "completed"]);
    expect(completionPath("verifying")).toEqual(["completed"]);
    expect(completionPath("ready")).toEqual([]);
  });

  it("classifies workspace-owning and restart-interruptible states", () => {
    expect([...WORKSPACE_ACTIVE_STATUSES].sort()).toEqual([
      "integrating",
      "running",
      "verifying",
    ]);
    expect([...INTERRUPTIBLE_STATUSES].sort()).toEqual([
      "drafting-intent",
      "integrating",
      "planning",
      "running",
      "verifying",
    ]);
    for (const status of INTERRUPTIBLE_STATUSES) {
      expect(canTransition(status, "cancelled"), status).toBe(true);
    }
  });
});
