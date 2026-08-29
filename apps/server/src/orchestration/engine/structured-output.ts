import type { z } from "zod";

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly responseExcerpt: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

function candidateJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start =
    objectStart < 0
      ? arrayStart
      : arrayStart < 0
        ? objectStart
        : Math.min(objectStart, arrayStart);
  if (start < 0) return trimmed;
  const opener = trimmed[start];
  const closer = opener === "[" ? "]" : "}";
  const end = trimmed.lastIndexOf(closer);
  return end >= start ? trimmed.slice(start, end + 1) : trimmed.slice(start);
}

export function parseStructuredOutput<T>(schema: z.ZodType<T>, text: string): T {
  const candidate = candidateJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new StructuredOutputError(
      "Model response was not valid JSON: " +
        (error instanceof Error ? error.message : String(error)),
      candidate.slice(0, 2_000),
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError(
      "Model response did not match the required schema: " +
        result.error.issues
          .slice(0, 8)
          .map((issue) => issue.path.join(".") + ": " + issue.message)
          .join("; "),
      candidate.slice(0, 2_000),
    );
  }
  return result.data;
}
