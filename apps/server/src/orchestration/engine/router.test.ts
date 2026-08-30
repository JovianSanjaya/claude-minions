import { describe, expect, it } from "vitest";
import type { ApplicationMap } from "./application-map.js";
import { decideRoute } from "./router.js";
import type { ExecutionContract } from "../contracts.js";

function criterion(
  id: string,
  description: string,
  kind: ExecutionContract["criteria"][number]["kind"] = "functional",
): ExecutionContract["criteria"][number] {
  return { id, kind, description, verification: "visible-test", provenance: "user-explicit", sourceClaimId: null };
}

function contractWith(criteria: ExecutionContract["criteria"]): ExecutionContract {
  return {
    id: "contract-1",
    orchestrationId: "orch-1",
    version: 1,
    intent: {
      id: "draft-1",
      orchestrationId: "orch-1",
      revision: 0,
      goal: "",
      requirements: [],
      assumptions: [],
      nonGoals: [],
      architectureDecisions: [],
      manualExpectations: [],
      openQuestions: [],
      createdAt: new Date().toISOString(),
    },
    criteria,
    confirmedBy: "user",
    confirmedAt: new Date().toISOString(),
    supersedesContractId: null,
  };
}

function mapWithDirs(directories: string[]): ApplicationMap {
  return {
    summary: {
      orchestrationId: "orch-1",
      version: 1,
      repositoryHash: "hash",
      summary: "",
      fileCount: 0,
      createdAt: new Date().toISOString(),
    },
    files: [],
    directories,
  };
}

describe("decideRoute", () => {
  it("routes direct for a single functional requirement", () => {
    const contract = contractWith([criterion("c1", "Users can request a reset email")]);
    const route = decideRoute(contract, mapWithDirs(["auth"]), "auto");
    expect(route.selectedMode).toBe("direct");
  });

  it("routes one-worker when multiple requirements cluster into a single module area", () => {
    const contract = contractWith([
      criterion("c1", "Users can request a reset in the auth module"),
      criterion("c2", "Reset tokens expire after use, handled in auth"),
    ]);
    const route = decideRoute(contract, mapWithDirs(["auth", "billing"]), "auto");
    expect(route.selectedMode).toBe("one-worker");
  });

  it("routes multi-worker when requirements span distinct module areas", () => {
    const contract = contractWith([
      criterion("c1", "Update the auth module to issue reset tokens"),
      criterion("c2", "Update the email module to send the reset message"),
      criterion("c3", "Update the frontend module to add a reset form"),
    ]);
    const route = decideRoute(contract, mapWithDirs(["auth", "email", "frontend"]), "auto");
    expect(route.selectedMode).toBe("multi-worker");
    expect(route.clusters.length).toBeGreaterThanOrEqual(3);
  });

  it("honors an explicit direct request regardless of size", () => {
    const contract = contractWith([
      criterion("c1", "auth change"),
      criterion("c2", "email change"),
      criterion("c3", "frontend change"),
    ]);
    const route = decideRoute(contract, mapWithDirs(["auth", "email", "frontend"]), "direct");
    expect(route.selectedMode).toBe("direct");
  });

  it("honors an explicit orchestrated request even for a single cluster, using one-worker", () => {
    const contract = contractWith([criterion("c1", "auth change"), criterion("c2", "another auth change")]);
    const route = decideRoute(contract, mapWithDirs(["auth"]), "orchestrated");
    expect(route.selectedMode).toBe("one-worker");
  });
});
