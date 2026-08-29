import { describe, expect, it } from "vitest";
import { redactDeep } from "./redaction.js";

describe("redactDeep", () => {
  it("redacts a bearer token embedded in free text", () => {
    const result = redactDeep(
      "call the API with Authorization: Bearer sk-ark-super-secret-123456 please",
    );
    expect(result).not.toContain("sk-ark-super-secret-123456");
    expect(result).toContain("[redacted]");
  });

  it("redacts values under obviously secret-shaped object keys", () => {
    const result = redactDeep({
      goal: "ship the feature",
      apiKey: "ark-live-abcdef123456",
      nested: { authorization: "Bearer xyz", password: "hunter2hunter2" },
    });
    expect(result.goal).toBe("ship the feature");
    expect(result.apiKey).toBe("[redacted]");
    expect(result.nested.authorization).toBe("[redacted]");
    expect(result.nested.password).toBe("[redacted]");
  });

  it("redacts key=value style assignments inside a string", () => {
    const result = redactDeep("ARK_API_KEY=abcd1234efgh5678 and everything else is fine");
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
    expect(redactDeep(input)).toEqual(input);
  });
});
