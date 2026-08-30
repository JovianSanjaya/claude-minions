import { z } from "zod";

/**
 * Structured-output helpers. Role calls that expect typed data parse the final
 * model message with a Zod schema; a malformed response gets exactly one
 * bounded repair attempt and then fails explicitly. A plan is never invented
 * from malformed text.
 */

export type StructuredParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Extracts the most plausible JSON object/array from a model message.
 * Handles fenced blocks and leading/trailing prose without executing anything.
 */
export function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fence = /```(?:json|jsonc)?\s*([\s\S]*?)```/gi;
  const fenced: string[] = [];
  for (const match of trimmed.matchAll(fence)) {
    const body = match[1]?.trim();
    if (body) fenced.push(body);
  }
  for (const candidate of fenced.reverse()) {
    if (isBalancedJsonish(candidate)) return candidate;
  }

  const direct = sliceOutermost(trimmed);
  if (direct) return direct;
  return null;
}

function isBalancedJsonish(candidate: string): boolean {
  const first = candidate[0];
  if (first !== "{" && first !== "[") return false;
  return sliceOutermost(candidate) !== null;
}

/** Scans for the outermost balanced object/array, ignoring braces in strings. */
function sliceOutermost(text: string): string | null {
  const start = firstStructuralIndex(text);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function firstStructuralIndex(text: string): number {
  const objectIndex = text.indexOf("{");
  const arrayIndex = text.indexOf("[");
  if (objectIndex < 0) return arrayIndex;
  if (arrayIndex < 0) return objectIndex;
  return Math.min(objectIndex, arrayIndex);
}

export function parseStructured<T>(
  schema: z.ZodType<T>,
  text: string,
): StructuredParseResult<T> {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return { ok: false, error: "No JSON object was present in the model response" };
  }
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      error: "Response was not valid JSON: " + summarizeError(error),
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: "Response did not match the required shape: " + issues(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => (issue.path.join(".") || "<root>") + ": " + issue.message)
    .join("; ");
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the single bounded repair prompt. It restates the required shape and
 * the exact validation failure; it never restates hidden reasoning.
 */
export function buildRepairPrompt(schemaDescription: string, failure: string): string {
  return [
    "Your previous reply could not be parsed.",
    "Validation failure: " + failure,
    "",
    "Reply again with a single JSON object and nothing else.",
    "Required shape:",
    schemaDescription,
  ].join("\n");
}
