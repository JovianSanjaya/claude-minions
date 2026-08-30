import type { ExecutionContract, RequestedExecutionMode, SelectedExecutionMode } from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";

export interface RouteCluster {
  label: string;
  directory: string | null;
  criterionIds: string[];
}

export interface RouteDecision {
  selectedMode: SelectedExecutionMode;
  routeReason: string;
  clusters: RouteCluster[];
}

/**
 * Groups the confirmed contract's functional criteria by which top-level
 * application-map directory their description mentions. This is a simple,
 * deterministic proxy for "modularity/coupling" — good enough to route
 * tiny/coupled work directly and modular work to multiple workers without
 * needing a live model call to make the routing decision itself.
 */
function clusterByDirectory(contract: ExecutionContract, applicationMap: ApplicationMap): RouteCluster[] {
  const topDirs = applicationMap.directories.filter((dir) => !dir.includes("/") && !dir.includes("\\"));
  const functional = contract.criteria.filter((criterion) => criterion.kind === "functional");
  const byLabel = new Map<string, RouteCluster>();
  for (const criterion of functional) {
    const description = criterion.description.toLowerCase();
    const matchedDir = topDirs.find((dir) => description.includes(dir.toLowerCase()));
    const label = matchedDir ?? "general";
    const existing = byLabel.get(label) ?? { label, directory: matchedDir ?? null, criterionIds: [] };
    existing.criterionIds.push(criterion.id);
    byLabel.set(label, existing);
  }
  return [...byLabel.values()];
}

/**
 * Deterministic adaptive routing: considers the requested mode override,
 * task size (functional criterion count), and modularity (directory
 * clustering) — the factors the spec calls out — without requiring a live
 * model call to make the decision, which keeps this both boundable and
 * fully testable against fixtures.
 */
export function decideRoute(
  contract: ExecutionContract,
  applicationMap: ApplicationMap,
  requestedMode: RequestedExecutionMode,
): RouteDecision {
  const clusters = clusterByDirectory(contract, applicationMap);
  const functionalCount = contract.criteria.filter((criterion) => criterion.kind === "functional").length;

  if (requestedMode === "direct") {
    return { selectedMode: "direct", routeReason: "User explicitly requested direct execution", clusters };
  }

  if (requestedMode === "orchestrated") {
    const selectedMode: SelectedExecutionMode = clusters.length >= 2 ? "multi-worker" : "one-worker";
    return {
      selectedMode,
      routeReason: `Orchestration explicitly requested; ${clusters.length} module cluster(s) identified across ${functionalCount} functional requirement(s)`,
      clusters,
    };
  }

  // auto
  if (functionalCount <= 1) {
    return {
      selectedMode: "direct",
      routeReason: `Only ${functionalCount} functional requirement — too small to be worth delegating`,
      clusters,
    };
  }
  if (clusters.length <= 1) {
    return {
      selectedMode: "one-worker",
      routeReason: `${functionalCount} functional requirements, but they cluster into a single module area — tightly coupled`,
      clusters,
    };
  }
  return {
    selectedMode: "multi-worker",
    routeReason: `${functionalCount} functional requirements span ${clusters.length} distinct module areas`,
    clusters,
  };
}
