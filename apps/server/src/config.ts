import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const optionalNonNegativeNumber = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.coerce.number().finite().nonnegative().optional(),
);

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL_OVERRIDE_SUPPORTED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  CODEX_MODEL_REASONING_EFFORT: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .default("low"),
  CODEX_MODEL_REASONING_SUMMARY: z
    .enum(["auto", "concise", "detailed", "none"])
    .default("none"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_TMPFS_SIZE: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("512m"),
  CONTAINER_SHM_SIZE: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("256m"),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ORCHESTRATION_BIG_MODEL: z.string().optional(),
  ORCHESTRATION_SMALL_MODEL: z.string().optional(),
  ORCHESTRATION_PLANNER_MODEL: z.string().optional(),
  ORCHESTRATION_WORKER_MODEL: z.string().optional(),
  ORCHESTRATION_VERIFIER_MODEL: z.string().optional(),
  ORCHESTRATION_INTEGRATOR_MODEL: z.string().optional(),
  ORCHESTRATION_RUNTIME_HOME_ROOT: z.string().optional(),
  ORCHESTRATION_TEMP_ROOT: z.string().optional(),
  ORCHESTRATION_ARCHIVE_ROOT: z.string().optional(),
  ORCHESTRATION_PROTECTED_EVALUATOR_ROOT: z.string().optional(),
  ORCHESTRATION_MAX_INPUT_TOKENS: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_OUTPUT_TOKENS: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_ESTIMATED_USD: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_MODEL_CALLS: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_STEPS: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_WORKER_ATTEMPTS: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_CONTEXT_EXPANSIONS: optionalNonNegativeNumber,
  ORCHESTRATION_MAX_WALL_CLOCK_MS: optionalNonNegativeNumber,
  ARK_INPUT_USD_PER_MILLION: optionalNonNegativeNumber,
  ARK_CACHED_INPUT_USD_PER_MILLION: optionalNonNegativeNumber,
  ARK_OUTPUT_USD_PER_MILLION: optionalNonNegativeNumber,
  ORCHESTRATION_DEMO_FIXTURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.ap-southeast.bytepluses.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  if (env.NODE_ENV === "production" && env.ORCHESTRATION_DEMO_FIXTURE) {
    throw new Error("ORCHESTRATION_DEMO_FIXTURE cannot be enabled in production");
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const dataDirectory = path.resolve(env.APP_DATA_DIR);
  const arkModel = env.ARK_MODEL?.trim() ?? "";
  const bigOrchestrationModel = env.ORCHESTRATION_BIG_MODEL?.trim() || arkModel;
  const smallOrchestrationModel =
    env.ORCHESTRATION_SMALL_MODEL?.trim() || bigOrchestrationModel;
  const orchestrationModels = {
    planner: env.ORCHESTRATION_PLANNER_MODEL?.trim() || bigOrchestrationModel,
    worker: env.ORCHESTRATION_WORKER_MODEL?.trim() || smallOrchestrationModel,
    verifier: env.ORCHESTRATION_VERIFIER_MODEL?.trim() || bigOrchestrationModel,
    integrator: env.ORCHESTRATION_INTEGRATOR_MODEL?.trim() || bigOrchestrationModel,
  };
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory,
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexModelOverrideSupported: env.CODEX_MODEL_OVERRIDE_SUPPORTED,
    codexModelReasoningEffort: env.CODEX_MODEL_REASONING_EFFORT,
    codexModelReasoningSummary: env.CODEX_MODEL_REASONING_SUMMARY,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerTmpfsSize: env.CONTAINER_TMPFS_SIZE,
    containerShmSize: env.CONTAINER_SHM_SIZE,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel,
    orchestrationModels,
    orchestrationRuntimeHomeRoot: path.resolve(
      env.ORCHESTRATION_RUNTIME_HOME_ROOT?.trim() || path.join(dataDirectory, "orchestration-runtime-homes"),
    ),
    orchestrationTempRoot: path.resolve(
      env.ORCHESTRATION_TEMP_ROOT?.trim() || path.join(dataDirectory, "orchestration-work"),
    ),
    orchestrationArchiveRoot: path.resolve(
      env.ORCHESTRATION_ARCHIVE_ROOT?.trim() || path.join(dataDirectory, "orchestration-archive"),
    ),
    orchestrationProtectedEvaluatorRoot: path.resolve(
      env.ORCHESTRATION_PROTECTED_EVALUATOR_ROOT?.trim() || path.join(dataDirectory, "protected-evaluators"),
    ),
    orchestrationDefaultBudget: {
      maxInputTokens: env.ORCHESTRATION_MAX_INPUT_TOKENS ?? null,
      maxOutputTokens: env.ORCHESTRATION_MAX_OUTPUT_TOKENS ?? null,
      maxEstimatedUsd: env.ORCHESTRATION_MAX_ESTIMATED_USD ?? null,
      maxModelCalls: env.ORCHESTRATION_MAX_MODEL_CALLS ?? 100,
      maxSteps: env.ORCHESTRATION_MAX_STEPS ?? 250,
      maxWorkerAttempts: env.ORCHESTRATION_MAX_WORKER_ATTEMPTS ?? 3,
      maxContextExpansionsPerTask: env.ORCHESTRATION_MAX_CONTEXT_EXPANSIONS ?? 3,
      maxWallClockMs: env.ORCHESTRATION_MAX_WALL_CLOCK_MS ?? 1_800_000,
    },
    orchestrationPricing: env.ARK_INPUT_USD_PER_MILLION !== undefined && env.ARK_CACHED_INPUT_USD_PER_MILLION !== undefined && env.ARK_OUTPUT_USD_PER_MILLION !== undefined
      ? (["planner", "worker", "verifier", "integrator"] as const).map((role) => ({ role, modelId: orchestrationModels[role], inputUsdPerMillion: env.ARK_INPUT_USD_PER_MILLION!, cachedInputUsdPerMillion: env.ARK_CACHED_INPUT_USD_PER_MILLION!, outputUsdPerMillion: env.ARK_OUTPUT_USD_PER_MILLION! }))
      : [],
    orchestrationDemoFixture: env.ORCHESTRATION_DEMO_FIXTURE,
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(
  config: AppConfig,
  targetHome: string = config.codexHome,
): Promise<void> {
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "model_reasoning_effort = " + JSON.stringify(config.codexModelReasoningEffort),
    "model_reasoning_summary = " + JSON.stringify(config.codexModelReasoningSummary),
    "model_supports_reasoning_summaries = " + String(config.codexModelReasoningSummary !== "none"),
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(targetHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
