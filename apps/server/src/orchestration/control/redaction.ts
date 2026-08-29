const SECRET_KEY_PATTERN =
  /(api[_-]?key|ark[_-]?api[_-]?key|authorization|auth[_-]?token|bearer|secret|password|passwd|access[_-]?token|private[_-]?key|cookie)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token>
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // key = value / key: value assignments that look like secrets
  /\b((?:ark[_-]?)?api[_-]?key|authorization|auth[_-]?token|secret|password|passwd|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?[^\s"',}]{4,}["']?/gi,
  // Common Ark/OpenAI-style bearer secrets
  /\bsk-[A-Za-z0-9]{16,}\b/g,
];

const REDACTED = "[redacted]";

function redactString(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Recursively redacts likely secrets (API keys, bearer tokens, authorization
 * headers, cookies, passwords, common secret assignments) from strings and
 * object fields. Applied before persistence and before API responses so that
 * neither the orchestration database nor the browser ever see raw secrets,
 * even if a user prompt or model output happens to include one.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        output[key] = typeof entry === "string" ? REDACTED : entry;
        continue;
      }
      output[key] = redactDeep(entry);
    }
    return output as unknown as T;
  }
  return value;
}
