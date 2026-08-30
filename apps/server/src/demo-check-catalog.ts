import type { TrustedCheckDefinition } from "./orchestration/engine/verification.js";

/**
 * Final Assembly's demo default check catalog.
 *
 * `TrustedCheckDefinition`s are keyed by confirmed contract criterion ID
 * (`control/service.ts` mints these as "c1", "c2", … per orchestration).
 *
 * This catalog pre-populates c1–c20 as `worker-visible` checks so that:
 *   1. `Object.values(checkCatalog)` (used by worker-loop to build
 *      `allowedCheckIds`) returns a non-empty array, meaning the worker's
 *      preflight report's `plannedChecks` can reference any of c1–c20 and
 *      pass the trusted-set gate.
 *   2. `scope: "worker-visible"` means these checks run *during each worker
 *      attempt* (run-checks after the worker's writes), not in the protected
 *      or global post-integration sweep.  The demo check (`node -e
 *      "process.exit(0)"`) always passes, so every attempt passes local
 *      verification.
 *   3. `installProtectedChecks` skips worker-visible entries, so the
 *      protected-storage file is written with an empty list — global
 *      verification then trivially passes too.
 *
 * This is a deliberately generic POC default.  A real deployment replaces
 * this with a project-specific catalog (for example
 * `{ "c1": { command: "npm", args: ["test"], scope: "protected", ... } }`)
 * built from the confirmed contract's actual criteria.  Nothing here is
 * browser-controlled: every command and argv list is fixed at server startup.
 */
export function createDemoCheckCatalog(): Record<string, TrustedCheckDefinition> {
  const DEMO_CHECK_COUNT = 20; // covers contracts with up to 20 criteria
  const catalog: Record<string, TrustedCheckDefinition> = {};
  for (let i = 1; i <= DEMO_CHECK_COUNT; i++) {
    const id = `c${i}`;
    catalog[id] = {
      id,
      description:
        "Demo sanity check (Final Assembly default): always passes with exit 0. " +
        "Replace with a project-specific check for anything beyond a POC demo.",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      scope: "worker-visible",
      timeoutMs: 30_000,
    };
  }
  return catalog;
}
