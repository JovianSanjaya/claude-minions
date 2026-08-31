import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("orchestration model configuration", () => {
  it("does not impose cumulative token budgets unless explicitly configured", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults.orchestrationDefaultBudget).toMatchObject({
      maxInputTokens: null,
      maxOutputTokens: null,
      maxModelCalls: 250,
      maxSteps: 750,
      maxWorkerAttempts: 5,
      maxContextExpansionsPerTask: 6,
      maxArkApiTurns: 500,
      maxArkApiTurnsPerExecution: 25,
      maxInputTokensPerExecution: 500_000,
    });
    expect(defaults).toMatchObject({
      codexTimeoutMs: 1_200_000,
      codexMaxOutputBytes: 4_194_304,
      containerCpuLimit: 4,
      containerMemoryLimit: "4g",
      containerPidsLimit: 512,
      containerTmpfsSize: "1g",
      containerShmSize: "512m",
      auditLogEnabled: true,
      auditLogMaximumBytes: 26_214_400,
      auditLogMaximumFiles: 5,
    });

    const configured = loadConfig({
      NODE_ENV: "test",
      ORCHESTRATION_MAX_INPUT_TOKENS: "2000000",
      ORCHESTRATION_MAX_OUTPUT_TOKENS: "500000",
    });
    expect(configured.orchestrationDefaultBudget).toMatchObject({
      maxInputTokens: 2_000_000,
      maxOutputTokens: 500_000,
    });
  });

  it("configures bounded Ark transport retries and per-execution limits", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_REQUEST_MAX_RETRIES: "5",
      ARK_STREAM_MAX_RETRIES: "7",
      ARK_STREAM_IDLE_TIMEOUT_MS: "240000",
      ORCHESTRATION_MODEL_TRANSPORT_MAX_RETRIES: "8",
      ORCHESTRATION_MAX_ARK_API_TURNS: "300",
      ORCHESTRATION_MAX_ARK_TURNS_PER_EXECUTION: "12",
      ORCHESTRATION_MAX_INPUT_TOKENS_PER_EXECUTION: "175000",
    });

    expect(config).toMatchObject({
      arkRequestMaxRetries: 5,
      arkStreamMaxRetries: 7,
      arkStreamIdleTimeoutMs: 240_000,
      orchestrationModelTransportMaxRetries: 8,
      orchestrationDefaultBudget: {
        maxArkApiTurns: 300,
        maxArkApiTurnsPerExecution: 12,
        maxInputTokensPerExecution: 175_000,
      },
    });
  });

  it("supports an effectively unbounded full-application profile", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ORCHESTRATION_UNRESTRICTED_MODE: "true",
    });
    expect(config.orchestrationUnrestrictedMode).toBe(true);
    expect(config.orchestrationDefaultBudget).toEqual({
      maxInputTokens: null,
      maxOutputTokens: null,
      maxEstimatedUsd: null,
      maxModelCalls: 10_000,
      maxSteps: 100_000,
      maxWorkerAttempts: 100,
      maxContextExpansionsPerTask: 100,
      maxArkApiTurns: 100_000,
      maxArkApiTurnsPerExecution: 50,
      maxInputTokensPerExecution: 1_000_000,
    });
  });

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
