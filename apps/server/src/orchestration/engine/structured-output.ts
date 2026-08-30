import { z } from "zod";

export class StructuredOutputError extends Error {
  constructor(message: string, public readonly issues: string[]) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new StructuredOutputError("Model response was not valid JSON", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

export function parseStructured<T>(schema: z.ZodType<T>, text: string): T {
  const parsed = extractJson(text);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError(
      "Model response did not match the required schema",
      result.error.issues.slice(0, 12).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  return result.data;
}

export function repairPrompt(
  error: StructuredOutputError,
  jsonSchema?: Record<string, unknown>,
): string {
  return [
    "Return only corrected JSON matching the requested schema.",
    "Do not include explanation or markdown fences.",
    `Validation problems: ${error.issues.join("; ")}`,
    ...(jsonSchema ? [`Required JSON Schema: ${JSON.stringify(jsonSchema)}`] : []),
  ].join("\n");
}
