import { describe, expect, it } from "vitest";
import { redactClone, redactString } from "./redaction.js";

describe("redaction", () => {
  it("redacts a bearer token embedded in free text", () => {
    const result = redactString(
      "call the API with Authorization: Bearer sk-ark-super-secret-123456 please",
    );
    expect(result).not.toContain("sk-ark-super-secret-123456");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts values under obviously secret-shaped object keys", () => {
    const result = redactClone({
      goal: "ship the feature",
      apiKey: "ark-live-abcdef123456",
      nested: { authorization: "Bearer xyz", password: "hunter2hunter2" },
    });
    expect(result.goal).toBe("ship the feature");
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.nested.authorization).toBe("[REDACTED]");
    expect(result.nested.password).toBe("[REDACTED]");
  });

  it("redacts key=value style assignments inside a string", () => {
    const result = redactString("ARK_API_KEY=abcd1234efgh5678 and everything else is fine");
    expect(result).not.toContain("abcd1234efgh5678");
    expect(result).toContain("everything else is fine");
  });

  it("leaves ordinary strings, arrays, and non-secret fields untouched", () => {
    const input = {
      requirements: ["add password reset", "send a confirmation email"],
      count: 3,
      ok: true,
      nothing: null,
    };
    expect(redactClone(input)).toEqual(input);
  });

  it("does not silently discard collection records after 250 entries", () => {
    const events = Array.from({ length: 300 }, (_, index) => ({ index, summary: `event ${index}` }));
    expect(redactClone(events)).toHaveLength(300);
    expect(redactClone(events).at(-1)).toEqual({ index: 299, summary: "event 299" });
  });
});
