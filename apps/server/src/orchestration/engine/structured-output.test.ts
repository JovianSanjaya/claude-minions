import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StructuredOutputError, parseStructuredOutput } from "./structured-output.js";

const schema = z.object({ goal: z.string(), count: z.number() });

describe("parseStructuredOutput", () => {
  it("parses bare JSON on the first attempt", async () => {
    const result = await parseStructuredOutput(schema, '{"goal":"ship it","count":3}');
    expect(result).toEqual({ value: { goal: "ship it", count: 3 }, repaired: false });
  });

  it("extracts JSON wrapped in a markdown code fence", async () => {
    const raw = 'Sure, here you go:\n```json\n{"goal":"ship it","count":3}\n```\nLet me know if that helps.';
    const result = await parseStructuredOutput(schema, raw);
    expect(result.value).toEqual({ goal: "ship it", count: 3 });
  });

  it("throws without a repair callback when the output is invalid", async () => {
    await expect(parseStructuredOutput(schema, "not json at all")).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
  });

  it("uses exactly one bounded repair attempt and succeeds if the repair is valid", async () => {
    let repairCalls = 0;
    const result = await parseStructuredOutput(schema, "garbage", async (_previous, _error) => {
      repairCalls += 1;
      return '{"goal":"fixed","count":1}';
    });
    expect(repairCalls).toBe(1);
    expect(result).toEqual({ value: { goal: "fixed", count: 1 }, repaired: true });
  });

  it("fails explicitly (never invents a value) when the repair attempt is also invalid", async () => {
    let repairCalls = 0;
    await expect(
      parseStructuredOutput(schema, "garbage", async () => {
        repairCalls += 1;
        return "still garbage";
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    expect(repairCalls).toBe(1);
  });

  it("fails when the JSON is well-formed but does not match the schema, even after repair", async () => {
    await expect(
      parseStructuredOutput(schema, '{"wrong":"shape"}', async () => '{"still":"wrong"}'),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
