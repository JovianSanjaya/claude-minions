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
    expect(config.bigOrchestrationModel).toBe("ep-big");
    expect(config.smallOrchestrationModel).toBe("ep-small");
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
    expect(config.orchestrationDefaultBudget).toMatchObject({
      maxInputTokens: 5_000_000,
      maxOutputTokens: 1_000_000,
    });
  });

  it("configures pricing for mixed and big-only role assignments", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_MODEL: "ep-default",
      ORCHESTRATION_BIG_MODEL: "ep-big",
      ORCHESTRATION_SMALL_MODEL: "ep-small",
      ARK_INPUT_USD_PER_MILLION: "1",
      ARK_CACHED_INPUT_USD_PER_MILLION: "0.5",
      ARK_OUTPUT_USD_PER_MILLION: "2",
    });
    expect(config.orchestrationPricing).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "worker", modelId: "ep-small" }),
      expect.objectContaining({ role: "worker", modelId: "ep-big" }),
    ]));
  });
});
