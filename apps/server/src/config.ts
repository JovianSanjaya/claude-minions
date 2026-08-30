import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Load `.env` from the repo root, if present, before anything reads
// process.env. Node's built-in `loadEnvFile` (stable since Node 20.6) never
// overrides a variable that is already set in the real environment, so an
// explicit `export FOO=...` or a container's injected env still wins over
// the file. This runs once at module load time, which is before
// `loadConfig()` below ever executes, regardless of whether this module was
// reached via `tsx watch` (dev), plain `node` (start/prod), or a test
// runner's cwd.
(function loadDotEnvIfPresent(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(import.meta.dirname, "../../../.env"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch (error) {
        console.warn(`Found ${candidate} but could not load it:`, error);
      }
      return;
    }
  }
})();

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
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
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ---------------------------------------------------------------------
  // Orchestration middleware (Task 2). Every field is optional and every
  // default is safe for a single configured Ark endpoint serving all roles.
  // ---------------------------------------------------------------------
  ORCHESTRATION_PLANNER_MODEL: z.string().trim().max(200).optional(),
  ORCHESTRATION_WORKER_MODEL: z.string().trim().max(200).optional(),
  ORCHESTRATION_VERIFIER_MODEL: z.string().trim().max(200).optional(),
  ORCHESTRATION_INTEGRATOR_MODEL: z.string().trim().max(200).optional(),
  /**
   * JSON map of model ID to USD price per million tokens, for example
   * {"ep-worker":{"input":0.3,"cachedInput":0.05,"output":1.2}}.
   * Missing entries keep estimated dollars null (`pricingStatus: "unknown"`).
   */
  ORCHESTRATION_MODEL_PRICING: z.string().optional(),
  ORCHESTRATION_TEMP_ROOT: z.string().optional(),
  ORCHESTRATION_ARCHIVE_ROOT: z.string().optional(),
  ORCHESTRATION_RUNTIME_HOME_ROOT: z.string().optional(),
  PROTECTED_EVALUATOR_ROOT: z.string().optional(),
  ORCHESTRATION_CLEANUP_POLICY: z
    .enum(["cleanup", "archive", "retain"])
    .default("archive"),
  ORCHESTRATION_MAX_INPUT_TOKENS: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORCHESTRATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(100_000_000).optional(),
  ORCHESTRATION_MAX_ESTIMATED_USD: z.coerce.number().positive().max(10_000).optional(),
  ORCHESTRATION_MAX_MODEL_CALLS: z.coerce.number().int().positive().max(1_000).default(40),
  ORCHESTRATION_MAX_STEPS: z.coerce.number().int().positive().max(2_000).default(80),
  ORCHESTRATION_MAX_WORKER_ATTEMPTS: z.coerce.number().int().positive().max(20).default(3),
  ORCHESTRATION_MAX_CONTEXT_EXPANSIONS: z.coerce.number().int().min(0).max(20).default(2),
  ORCHESTRATION_MAX_WALL_CLOCK_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60_000)
    .default(900_000),
});

const pricingSchema = z.record(
  z.string(),
  z.object({
    input: z.number().min(0).optional(),
    cachedInput: z.number().min(0).optional(),
    output: z.number().min(0).optional(),
  }),
);

/** USD per million tokens, by model ID. */
export type ModelPricingTable = z.infer<typeof pricingSchema>;

function parsePricing(raw: string | undefined): ModelPricingTable {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ORCHESTRATION_MODEL_PRICING must be valid JSON");
  }
  const result = pricingSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      "ORCHESTRATION_MODEL_PRICING must map model IDs to non-negative input/cachedInput/output prices",
    );
  }
  return result.data;
}

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
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  const dataDirectory = path.resolve(env.APP_DATA_DIR);
  const arkModel = env.ARK_MODEL?.trim() ?? "";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory,
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel,
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
    orchestration: {
      /** Logical role to trusted model ID. Empty means "use the Ark model". */
      models: {
        fallbackModelId: arkModel,
        ...(env.ORCHESTRATION_PLANNER_MODEL
          ? { planner: env.ORCHESTRATION_PLANNER_MODEL }
          : {}),
        ...(env.ORCHESTRATION_WORKER_MODEL
          ? { worker: env.ORCHESTRATION_WORKER_MODEL }
          : {}),
        ...(env.ORCHESTRATION_VERIFIER_MODEL
          ? { verifier: env.ORCHESTRATION_VERIFIER_MODEL }
          : {}),
        ...(env.ORCHESTRATION_INTEGRATOR_MODEL
          ? { integrator: env.ORCHESTRATION_INTEGRATOR_MODEL }
          : {}),
      },
      pricing: parsePricing(env.ORCHESTRATION_MODEL_PRICING),
      tempRoot: path.resolve(
        env.ORCHESTRATION_TEMP_ROOT ?? path.join(dataDirectory, "orchestration", "temp"),
      ),
      archiveRoot: path.resolve(
        env.ORCHESTRATION_ARCHIVE_ROOT ??
          path.join(dataDirectory, "orchestration", "archive"),
      ),
      runtimeHomeRoot: path.resolve(
        env.ORCHESTRATION_RUNTIME_HOME_ROOT ??
          path.join(dataDirectory, "orchestration", "runtime-homes"),
      ),
      protectedEvaluatorRoot: path.resolve(
        env.PROTECTED_EVALUATOR_ROOT ??
          path.join(dataDirectory, "protected-evaluators"),
      ),
      cleanupPolicy: env.ORCHESTRATION_CLEANUP_POLICY,
      budget: {
        maxInputTokens: env.ORCHESTRATION_MAX_INPUT_TOKENS ?? null,
        maxOutputTokens: env.ORCHESTRATION_MAX_OUTPUT_TOKENS ?? null,
        maxEstimatedUsd: env.ORCHESTRATION_MAX_ESTIMATED_USD ?? null,
        maxModelCalls: env.ORCHESTRATION_MAX_MODEL_CALLS,
        maxSteps: env.ORCHESTRATION_MAX_STEPS,
        maxWorkerAttempts: env.ORCHESTRATION_MAX_WORKER_ATTEMPTS,
        maxContextExpansionsPerTask: env.ORCHESTRATION_MAX_CONTEXT_EXPANSIONS,
        maxWallClockMs: env.ORCHESTRATION_MAX_WALL_CLOCK_MS,
      },
    },
  };
}

/** Convenience accessor used by Final Assembly when creating orchestrations. */
export function defaultBudgetPolicy(config: AppConfig): AppConfig["orchestration"]["budget"] {
  return { ...config.orchestration.budget };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

/**
 * Renders the Codex CLI `config.toml` that points it at Volcengine Ark
 * instead of its own OpenAI default. Shared by `writeCodexConfig` (the
 * long-lived `CODEX_HOME` used for direct Playground runs) and by the
 * orchestration engine, which must seed this same file into every fresh,
 * isolated per-role `CODEX_HOME` it creates for an orchestration execution
 * (see `driver.ts`'s `runtimeHomes()`) -- otherwise Codex CLI finds no
 * config in that new directory and silently falls back to
 * `https://api.openai.com/v1/responses` with no API key, which surfaces as
 * a confusing "401 Unauthorized: Missing bearer or basic authentication"
 * error that has nothing to do with the user's actual (correct) Ark
 * credentials.
 */
export function buildCodexConfigToml(config: AppConfig): string {
  return [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = buildCodexConfigToml(config);
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
