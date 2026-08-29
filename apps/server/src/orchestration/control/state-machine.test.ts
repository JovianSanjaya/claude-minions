import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  TERMINAL_STATUSES,
  assertLegalTransition,
  isLegalTransition,
} from "./state-machine.js";

describe("orchestration state machine", () => {
  it("allows the legal transitions this restricted build exercises", () => {
    expect(isLegalTransition("drafting-intent", "awaiting-confirmation")).toBe(true);
    expect(isLegalTransition("awaiting-confirmation", "drafting-intent")).toBe(true);
    expect(isLegalTransition("awaiting-confirmation", "planning")).toBe(true);
    expect(isLegalTransition("planning", "needs-user")).toBe(true);
    expect(isLegalTransition("needs-user", "planning")).toBe(true);
    expect(isLegalTransition("needs-user", "awaiting-confirmation")).toBe(true);
  });

  it("allows the fuller execution-path transitions for downstream tasks", () => {
    expect(isLegalTransition("planning", "ready")).toBe(true);
    expect(isLegalTransition("ready", "running")).toBe(true);
    expect(isLegalTransition("running", "integrating")).toBe(true);
    expect(isLegalTransition("running", "budget-exhausted")).toBe(true);
    expect(isLegalTransition("integrating", "verifying")).toBe(true);
    expect(isLegalTransition("verifying", "completed")).toBe(true);
  });

  it("rejects illegal transitions such as skipping confirmation", () => {
    expect(isLegalTransition("drafting-intent", "planning")).toBe(false);
    expect(isLegalTransition("awaiting-confirmation", "ready")).toBe(false);
    expect(isLegalTransition("drafting-intent", "completed")).toBe(false);
  });

  it("rejects any transition out of a terminal status", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isLegalTransition(status, "planning")).toBe(false);
      expect(isLegalTransition(status, "cancelled")).toBe(false);
    }
  });

  it("allows cancellation from any non-terminal status", () => {
    const nonTerminal = [
      "drafting-intent",
      "awaiting-confirmation",
      "planning",
      "ready",
      "running",
      "integrating",
      "verifying",
      "needs-user",
    ] as const;
    for (const status of nonTerminal) {
      expect(isLegalTransition(status, "cancelled")).toBe(true);
    }
  });

  it("throws IllegalTransitionError with the offending states on an illegal move", () => {
    expect(() => assertLegalTransition("drafting-intent", "planning")).toThrow(
      IllegalTransitionError,
    );
    try {
      assertLegalTransition("completed", "planning");
      throw new Error("expected assertLegalTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe("completed");
      expect((error as IllegalTransitionError).to).toBe("planning");
    }
  });
});
