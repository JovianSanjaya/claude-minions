/**
 * Redaction and bounding helpers for the orchestration control plane.
 *
 * Everything the control plane persists passes through {@link redactRecord}
 * before it reaches disk, so secrets are removed *before* persistence rather
 * than only at response-rendering time. Read models pass through it a second
 * time, plus {@link maskFilesystemPaths}, before leaving the process.
 *
 * This is defence in depth for a hackathon POC, not a proof of secrecy. A
 * bare credential that looks exactly like an ordinary identifier (for example
 * a raw UUID Ark key with no surrounding assignment) cannot be distinguished
 * from a legitimate ID and is documented as a known limitation.
 */

export const REDACTED = "[redacted]";

/** Default maximum stored length for any single string. */
export const DEFAULT_STRING_LIMIT = 4_000;

/** Maximum number of entries kept in an array of strings. */
export const MAX_STRING_ARRAY_ITEMS = 200;

/** Maximum number of entries kept in any array. */
export const MAX_ARRAY_ITEMS = 5_000;

/** Maximum recursion depth before a value is replaced wholesale. */
const MAX_DEPTH = 12;

/**
 * Per-field stored-size limits. Keys are contract field names; anything not
 * listed uses {@link DEFAULT_STRING_LIMIT}.
 */
const FIELD_STRING_LIMITS: Readonly<Record<string, number>> = {
  prompt: 20_000,
  finalOutput: 20_000,
  payload: 8_000,
  summary: 2_000,
  outputSummary: 4_000,
  errorSummary: 2_000,
  error: 2_000,
  lastError: 2_000,
  reason: 1_000,
  routeReason: 1_000,
  goal: 2_000,
  objective: 2_000,
  title: 300,
  description: 2_000,
  diffSummary: 4_000,
  workerDiagnosis: 2_000,
  commandOrCheck: 500,
  path: 1_000,
};

/**
 * Field names whose *values* are always replaced with {@link REDACTED} when
 * they hold a string. Numeric fields such as `maxInputTokens` are untouched.
 */
const SECRET_KEY_PATTERN =
  /^(?:ark[_-]?)?(?:api[_-]?key|apikey|secret|secrets|password|passwd|pwd|credential|credentials|authorization|auth[_-]?token|bearer[_-]?token|access[_-]?key|private[_-]?key|cookie|session[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;

/**
 * Field names that are dropped entirely: hidden reasoning, protected evaluator
 * material, whole-file payloads and environment dumps must never be persisted
 * or rendered, even in redacted form.
 */
const FORBIDDEN_KEY_PATTERN =
  /^(?:reasoning|reasoning[_-]?content|chain[_-]?of[_-]?thought|cot|thinking|thoughts|hidden[_-]?reasoning|protected[_-]?source|protected[_-]?test[_-]?source|protected[_-]?tests|protected[_-]?script|evaluator[_-]?source|evaluator[_-]?script|source[_-]?code|file[_-]?content|file[_-]?contents|raw[_-]?source|env|environ|environment|process[_-]?env|env[_-]?dump)$/i;

/** Substring rules applied to every stored string. */
const TEXT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer " + REDACTED],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [
    /((?:[A-Z][A-Z0-9]*_)*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|ACCESS_KEY|PRIVATE_KEY))\s*=\s*[^\s'";,]+/g,
    "$1=" + REDACTED,
  ],
  [
    /(["']?(?<![\w-])(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|client[_-]?secret|password|passwd|token|auth[_-]?token|bearer|authorization|cookie|credential|credentials)(?![\w-])["']?\s*[:=]\s*)["']?[^\s"',;}\]]{4,}["']?/gi,
    "$1" + REDACTED,
  ],
];

/**
 * Absolute filesystem roots that must not leak to the browser. Only the last
 * two segments survive so evidence stays readable without disclosing the
 * server's directory layout.
 */
const ABSOLUTE_PATH_PATTERN =
  /(?<![\w:])\/(?:home|root|Users|var|tmp|private|opt|srv|mnt|data|workspaces|codex-home|Applications|Library)(?:\/[^\s"'`,;:)\]]+)+/gi;

export function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(0, limit) + "... [truncated]";
}

/** Applies substring redaction rules and the size bound to one string. */
export function redactString(value: string, limit = DEFAULT_STRING_LIMIT): string {
  let output = value;
  for (const [pattern, replacement] of TEXT_RULES) {
    output = output.replace(pattern, replacement);
  }
  return truncate(output, limit);
}

/**
 * Replaces absolute server filesystem paths with a bounded, non-locating form.
 * Applied to read models only; stored data keeps whatever the driver recorded
 * so operators can still debug from the JSON database on the trusted host.
 */
export function maskFilesystemPaths(value: string): string {
  return value.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    const segments = match.split("/").filter((segment) => segment.length > 0);
    const tail = segments.slice(-2).join("/");
    return tail.length > 0 ? "<path>/" + tail : "<path>";
  });
}

function limitFor(key: string | undefined): number {
  if (key === undefined) {
    return DEFAULT_STRING_LIMIT;
  }
  return FIELD_STRING_LIMITS[key] ?? DEFAULT_STRING_LIMIT;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RedactOptions {
  /** Also mask absolute filesystem paths. Used for read models. */
  readonly maskPaths?: boolean;
}

function redactUnknown(
  value: unknown,
  key: string | undefined,
  depth: number,
  options: RedactOptions,
): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (key !== undefined && SECRET_KEY_PATTERN.test(key)) {
      return REDACTED;
    }
    const redacted = redactString(value, limitFor(key));
    return options.maskPaths === true ? maskFilesystemPaths(redacted) : redacted;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    const everyItemIsString = value.every((item) => typeof item === "string");
    const cap = everyItemIsString ? MAX_STRING_ARRAY_ITEMS : MAX_ARRAY_ITEMS;
    return value
      .slice(0, cap)
      .map((item) => redactUnknown(item, key, depth + 1, options));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(childKey)) {
        continue;
      }
      output[childKey] = redactUnknown(childValue, childKey, depth + 1, options);
    }
    return output;
  }
  // Functions, symbols and class instances are never persisted.
  return REDACTED;
}

/**
 * Deeply redacts, bounds and clones any record before it is persisted.
 * The returned value is structurally the same shape minus forbidden keys.
 */
export function redactRecord<T>(value: T): T {
  return redactUnknown(value, undefined, 0, {}) as T;
}

/**
 * Deeply redacts a record for API responses. Identical to
 * {@link redactRecord} plus absolute-path masking.
 */
export function redactForResponse<T>(value: T): T {
  return redactUnknown(value, undefined, 0, { maskPaths: true }) as T;
}
