import type { z } from "zod";

export interface StructuredOutputResult<T> {
  value: T;
  repaired: boolean;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/**
 * Models (and their fakes in tests) commonly wrap JSON in prose or a code
 * fence. This extracts the first plausible JSON object/array rather than
 * requiring the entire message to be bare JSON.
 */
function extractJsonCandidate(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.search(/[{[]/);
  if (start === -1) return candidate.trim();
  return candidate.slice(start).trim();
}

function tryParse<T>(schema: z.ZodType<T>, text: string): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonCandidate(text));
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.message };
}

/**
 * Parses a role's free-text output against a Zod schema, allowing at most
 * one bounded repair attempt (per spec: "allow at most one bounded repair
 * attempt for invalid JSON/shape ... Schema failures after repair must fail
 * or escalate explicitly. Never invent a plan from malformed text."). The
 * `repair` callback is expected to make one more model call with the error
 * folded into the prompt; if omitted, or if the repair attempt also fails
 * validation, this throws `StructuredOutputError` rather than guessing.
 */
export async function parseStructuredOutput<T>(
  schema: z.ZodType<T>,
  rawOutput: string,
  repair?: (previousOutput: string, error: string) => Promise<string>,
): Promise<StructuredOutputResult<T>> {
  const first = tryParse(schema, rawOutput);
  if (first.ok) {
    return { value: first.value, repaired: false };
  }
  if (!repair) {
    throw new StructuredOutputError(`Structured output invalid: ${first.error}`, rawOutput);
  }
  const repairedText = await repair(rawOutput, first.error);
  const second = tryParse(schema, repairedText);
  if (second.ok) {
    return { value: second.value, repaired: true };
  }
  throw new StructuredOutputError(
    `Structured output still invalid after one bounded repair attempt: ${second.error}`,
    repairedText,
  );
}
