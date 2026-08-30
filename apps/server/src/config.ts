import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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

  // --- Orchestration middleware (all optional; safe defaults support a
  // single configured Ark endpoint filling every logical role) ---
  PLANNER_MODEL_ID: z.string().trim().min(1).optional(),
  WORKER_MODEL_ID: z.string().trim().min(1).optional(),
  VERIFIER_MODEL_ID: z.string().trim().min(1).optional(),
  INTEGRATOR_MODEL_ID: z.string().trim().min(1).optional(),
  // A single set of per-token prices applied uniformly across roles when
  // present. Real per-role pricing would need one set per role; this is a
  // deliberate simplification (see docs/handoffs/task-1-control-plane.md).
  // Missing any of the three keeps pricing "unknown" (never a fabricated cost).
  ARK_INPUT_PRICE_PER_TOKEN: z.coerce.number().nonnegative().optional(),
  ARK_CACHED_INPUT_PRICE_PER_TOKEN: z.coerce.number().nonnegative().optional(),
  ARK_OUTPUT_PRICE_PER_TOKEN: z.coerce.number().nonnegative().optional(),
  ORCHESTRATION_SCRATCH_ROOT: z.string().optional(),
  PROTECTED_EVALUATOR_ROOT: z.string().optional(),
  // Space-separated command + args for the one example global (non-hidden)
  // verification check wired by default, e.g. "npm run typecheck". No
  // shell is invoked; the browser/worker can never influence this value.
  GLOBAL_CHECK_COMMAND: z.string().optional(),
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
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";

  const modelIds: Partial<Record<"planner" | "worker" | "verifier" | "integrator", string>> = {};
  if (env.PLANNER_MODEL_ID) modelIds.planner = env.PLANNER_MODEL_ID;
  if (env.WORKER_MODEL_ID) modelIds.worker = env.WORKER_MODEL_ID;
  if (env.VERIFIER_MODEL_ID) modelIds.verifier = env.VERIFIER_MODEL_ID;
  if (env.INTEGRATOR_MODEL_ID) modelIds.integrator = env.INTEGRATOR_MODEL_ID;

  const rolePricing =
    env.ARK_INPUT_PRICE_PER_TOKEN !== undefined &&
    env.ARK_CACHED_INPUT_PRICE_PER_TOKEN !== undefined &&
    env.ARK_OUTPUT_PRICE_PER_TOKEN !== undefined
      ? {
          inputPerToken: env.ARK_INPUT_PRICE_PER_TOKEN,
          cachedInputPerToken: env.ARK_CACHED_INPUT_PRICE_PER_TOKEN,
          outputPerToken: env.ARK_OUTPUT_PRICE_PER_TOKEN,
        }
      : null;
  const pricing = rolePricing
    ? { planner: rolePricing, worker: rolePricing, verifier: rolePricing, integrator: rolePricing }
    : null;

  const globalCheckCommand = env.GLOBAL_CHECK_COMMAND?.trim();
  const globalCheck = globalCheckCommand
    ? (() => {
        const [command, ...args] = globalCheckCommand.split(/\s+/);
        return command ? { command, args } : null;
      })()
    : null;

  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
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
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
    orchestrationModelIds: modelIds,
    orchestrationPricing: pricing,
    orchestrationScratchRoot: path.resolve(
      env.ORCHESTRATION_SCRATCH_ROOT ?? path.join(env.APP_DATA_DIR, "orchestration-tmp"),
    ),
    protectedEvaluatorRoot: path.resolve(
      env.PROTECTED_EVALUATOR_ROOT ?? path.join(env.APP_DATA_DIR, "protected-evaluators"),
    ),
    orchestrationGlobalCheck: globalCheck,
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

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
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
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
