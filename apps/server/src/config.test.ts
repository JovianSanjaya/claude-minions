import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("orchestration model configuration", () => {
  it("shares one big endpoint across trusted roles and one small endpoint across workers", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_MODEL: "ep-default",
      ORCHESTRATION_BIG_MODEL: "ep-big",
      ORCHESTRATION_SMALL_MODEL: "ep-small",
    });

    expect(config.orchestrationModels).toEqual({
      planner: "ep-big",
      worker: "ep-small",
      verifier: "ep-big",
      integrator: "ep-big",
    });
  });

  it("keeps advanced per-role overrides and falls back safely", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_MODEL: "ep-default",
      ORCHESTRATION_BIG_MODEL: "ep-big",
      ORCHESTRATION_SMALL_MODEL: "ep-small",
      ORCHESTRATION_VERIFIER_MODEL: "ep-verifier",
      ORCHESTRATION_WORKER_MODEL: "ep-worker",
    });

    expect(config.orchestrationModels).toEqual({
      planner: "ep-big",
      worker: "ep-worker",
      verifier: "ep-verifier",
      integrator: "ep-big",
    });
  });

  it("uses ARK_MODEL for every role when grouped overrides are absent", () => {
    const config = loadConfig({ NODE_ENV: "test", ARK_MODEL: "ep-default" });

    expect(config.orchestrationModels).toEqual({
      planner: "ep-default",
      worker: "ep-default",
      verifier: "ep-default",
      integrator: "ep-default",
    });
  });
});
