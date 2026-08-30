import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRING_LIMIT,
  maskFilesystemPaths,
  redactForResponse,
  redactRecord,
  redactString,
  truncate,
} from "./redaction.js";

describe("redaction", () => {
  it("removes bearer tokens and authorization values from free text", () => {
    const redacted = redactString(
      "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9secret' https://example.test",
    );
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9secret");
    expect(redacted).toContain("[redacted]");
  });

  it("removes environment-style credential assignments but keeps the variable name", () => {
    const redacted = redactString("ARK_API_KEY=abc-123-def APP_AUTH_TOKEN=zzz-token-value");
    expect(redacted).toContain("ARK_API_KEY=[redacted]");
    expect(redacted).toContain("APP_AUTH_TOKEN=[redacted]");
    expect(redacted).not.toContain("abc-123-def");
    expect(redacted).not.toContain("zzz-token-value");
  });

  it("removes JSON-style secret assignments and sk- keys", () => {
    const redacted = redactString('{"api_key": "sk-abcdefghijklmnopqrst", "note": "keep"}');
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrst");
    expect(redacted).toContain("keep");
  });

  it("does not damage token-count fields that merely contain the word token", () => {
    const redacted = redactString("estimatedInputTokens: 1200, maxOutputTokens: 400");
    expect(redacted).toBe("estimatedInputTokens: 1200, maxOutputTokens: 400");
  });

  it("replaces secret-named string fields wholesale but leaves numbers alone", () => {
    const redacted = redactRecord({
      apiKey: "plain-value-here",
      password: "hunter2",
      maxInputTokens: 1_000,
      cachedInputTokens: 12,
    });
    expect(redacted.apiKey).toBe("[redacted]");
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.maxInputTokens).toBe(1_000);
    expect(redacted.cachedInputTokens).toBe(12);
  });

  it("drops hidden reasoning, protected evaluator material and environment dumps", () => {
    const redacted = redactRecord({
      summary: "worker finished",
      reasoning: "step 1 ... step 2 ...",
      chainOfThought: "hidden",
      protectedTestSource: "expect(reset(token)).toBe(true)",
      evaluatorSource: "assert...",
      fileContents: "the entire file",
      env: { ARK_API_KEY: "x" },
    }) as Record<string, unknown>;

    expect(redacted).toEqual({ summary: "worker finished" });
  });

  it("bounds stored strings and arrays", () => {
    const redacted = redactRecord({
      summary: "s".repeat(5_000),
      requirements: Array.from({ length: 500 }, (_unused, index) => "req " + index),
    });
    expect(redacted.summary.length).toBeLessThanOrEqual(2_000 + 20);
    expect(redacted.summary.endsWith("... [truncated]")).toBe(true);
    expect(redacted.requirements).toHaveLength(200);
  });

  it("uses the default limit for unlisted fields", () => {
    const redacted = redactRecord({ unlistedField: "s".repeat(DEFAULT_STRING_LIMIT + 500) });
    expect(redacted.unlistedField.startsWith("s")).toBe(true);
    expect(redacted.unlistedField.length).toBeLessThan(DEFAULT_STRING_LIMIT + 500);
  });

  it("replaces non-finite numbers with null", () => {
    const redacted = redactRecord({ ratio: Number.NaN, total: Number.POSITIVE_INFINITY });
    expect(redacted.ratio).toBeNull();
    expect(redacted.total).toBeNull();
  });

  it("masks absolute server paths only in responses", () => {
    const stored = redactRecord({ path: "/home/agent/workspaces/agent-1/src/reset.ts" });
    expect(stored.path).toContain("/home/agent/workspaces");

    const response = redactForResponse({
      path: "/home/agent/workspaces/agent-1/src/reset.ts",
    });
    expect(response.path).toBe("<path>/src/reset.ts");
  });

  it("leaves API route strings untouched when masking paths", () => {
    expect(maskFilesystemPaths("POST /api/orchestrations/:id/confirm")).toBe(
      "POST /api/orchestrations/:id/confirm",
    );
  });

  it("truncates deterministically", () => {
    expect(truncate("abcdef", 3)).toBe("abc... [truncated]");
    expect(truncate("abc", 3)).toBe("abc");
  });
});
