import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("orchestration model configuration", () => {
  it("does not impose cumulative token budgets unless explicitly configured", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults.orchestrationDefaultBudget).toMatchObject({
      maxInputTokens: null,
      maxOutputTokens: null,
      maxArkApiTurns: 240,
      maxArkApiTurnsPerExecution: 20,
      maxInputTokensPerExecution: 250_000,
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
      ORCHESTRATION_MAX_ARK_API_TURNS: "300",
      ORCHESTRATION_MAX_ARK_TURNS_PER_EXECUTION: "12",
      ORCHESTRATION_MAX_INPUT_TOKENS_PER_EXECUTION: "175000",
    });

    expect(config).toMatchObject({
      arkRequestMaxRetries: 5,
      arkStreamMaxRetries: 7,
      arkStreamIdleTimeoutMs: 240_000,
      orchestrationDefaultBudget: {
        maxArkApiTurns: 300,
        maxArkApiTurnsPerExecution: 12,
        maxInputTokensPerExecution: 175_000,
      },
    });
  });

  it("keeps Ark retries separate from durable orchestration transport recovery", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(defaults).toMatchObject({
      codexTimeoutMs: 1_800_000,
      arkStreamIdleTimeoutMs: 1_800_000,
      orchestrationTransportRetryPolicy: {
        maxRetries: null,
        pauseAfterMs: 300_000,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
        jitterRatio: 0.2,
      },
    });

    const configured = loadConfig({
      NODE_ENV: "test",
      ARK_REQUEST_MAX_RETRIES: "2",
      ARK_STREAM_MAX_RETRIES: "4",
      ORCHESTRATION_TRANSPORT_MAX_RETRIES: "12",
      ORCHESTRATION_TRANSPORT_RETRY_WINDOW_MS: "90000",
      ORCHESTRATION_TRANSPORT_RETRY_BASE_MS: "250",
      ORCHESTRATION_TRANSPORT_RETRY_MAX_DELAY_MS: "5000",
      ORCHESTRATION_TRANSPORT_RETRY_JITTER_RATIO: "0.1",
    });
    expect(configured.arkRequestMaxRetries).toBe(2);
    expect(configured.arkStreamMaxRetries).toBe(4);
    expect(configured.orchestrationTransportRetryPolicy).toEqual({
      maxRetries: 12,
      pauseAfterMs: 90_000,
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      jitterRatio: 0.1,
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
