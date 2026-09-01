import { describe, expect, it } from "vitest";
import type { OrchestrationStatus } from "../contracts.js";
import {
  assertTransition,
  legalTransitionsFrom,
  terminalOrchestrationStatuses,
} from "./state-machine.js";

describe("orchestration state machine", () => {
  it("accepts every declared legal transition and cancellation from active states", () => {
    const statuses: OrchestrationStatus[] = [
      "drafting-intent", "awaiting-confirmation", "planning", "ready", "running",
      "integrating", "verifying", "needs-user", "budget-exhausted", "completed",
      "failed", "cancelled",
    ];
    for (const status of statuses) {
      for (const target of legalTransitionsFrom(status)) {
        expect(() => assertTransition(status, target)).not.toThrow();
      }
      if (!terminalOrchestrationStatuses.has(status)) {
        expect(legalTransitionsFrom(status)).toContain("cancelled");
      }
    }
  });

  it("rejects representative illegal and terminal transitions", () => {
    expect(() => assertTransition("awaiting-confirmation", "running")).toThrow(
      "Illegal orchestration transition",
    );
    expect(() => assertTransition("completed", "running")).toThrow();
    expect(() => assertTransition("cancelled", "completed")).toThrow();
  });
});
