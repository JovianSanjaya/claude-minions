const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 8_000;
const MAX_OBJECT_KEYS = 250;

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    ["authorization", "cookie", "password", "passwd", "secret", "token", "apikey", "credential", "privatekey", "env", "environment"].includes(normalized) ||
    ["accesstoken", "authtoken", "bearertoken", "refreshtoken", "apikey", "password", "passwd", "secret", "credential", "privatekey"].some((suffix) => normalized.endsWith(suffix)) ||
    normalized.startsWith("environmentdump")
  );
}

const secretPatterns: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:Authorization|Cookie)\s*:\s*[^\r\n]+/gi,
  /\b(?:ARK_API_KEY|APP_AUTH_TOKEN|API_KEY|PASSWORD|SECRET|ACCESS_TOKEN)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /\b(?:sk|ak)-[A-Za-z0-9_-]{12,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactString(value: string, maxLength = MAX_STRING_LENGTH): string {
  let safe = value;
  for (const pattern of secretPatterns) {
    safe = safe.replace(pattern, REDACTED);
  }
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}…[truncated]` : safe;
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    // Collection retention is owned by the store, not the redactor. Truncating
    // here silently discarded every event after the first 250 records.
    const result = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    result[key] = isSecretKey(key) ? REDACTED : redactValue(entry, seen);
  }
  seen.delete(value);
  return result;
}

export function redactClone<T>(value: T): T {
  return redactValue(structuredClone(value)) as T;
}
