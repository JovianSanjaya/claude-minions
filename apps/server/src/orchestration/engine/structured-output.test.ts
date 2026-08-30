import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRepairPrompt,
  extractJsonCandidate,
  parseStructured,
} from "./structured-output.js";

const schema = z.object({ goal: z.string(), items: z.array(z.string()) });

describe("structured output parsing", () => {
  it("reads a fenced JSON block surrounded by prose", () => {
    const text = [
      "Here is my plan.",
      "```json",
      '{ "goal": "ship", "items": ["a"] }',
      "```",
      "Let me know if that works.",
    ].join("\n");
    const parsed = parseStructured(schema, text);
    expect(parsed).toEqual({ ok: true, value: { goal: "ship", items: ["a"] } });
  });

  it("reads a bare object and ignores trailing text", () => {
    const parsed = parseStructured(schema, '{"goal":"ship","items":[]}\nDone.');
    expect(parsed.ok).toBe(true);
  });

  it("does not confuse braces inside strings", () => {
    const candidate = extractJsonCandidate('{"goal":"a } b","items":[]}');
    expect(candidate).toBe('{"goal":"a } b","items":[]}');
  });

  it("reports a shape failure instead of inventing a value", () => {
    const parsed = parseStructured(schema, '{"goal": 12, "items": "no"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("did not match the required shape");
    }
  });

  it("reports missing JSON rather than guessing", () => {
    const parsed = parseStructured(schema, "I could not do that.");
    expect(parsed).toEqual({
      ok: false,
      error: "No JSON object was present in the model response",
    });
  });

  it("builds a repair prompt that restates the schema and the failure", () => {
    const prompt = buildRepairPrompt("{ shape }", "goal: expected string");
    expect(prompt).toContain("goal: expected string");
    expect(prompt).toContain("{ shape }");
    expect(prompt).toContain("single JSON object");
  });
});
