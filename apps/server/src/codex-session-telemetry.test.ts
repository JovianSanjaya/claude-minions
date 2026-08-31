import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexSessionTelemetryTracker,
  executionBudgetExceeded,
} from "./codex-session-telemetry.js";

function tokenEvent(total: number, input: number, cached: number, output: number) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total - output,
          cached_input_tokens: cached,
          output_tokens: output,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          total_tokens: input + output,
        },
      },
    },
  });
}

describe("Codex session telemetry", () => {
  it("enforces the first bounded execution limit reached, including tool calls", () => {
    expect(executionBudgetExceeded(
      { maxArkApiTurns: 8, maxInputTokens: 200_000, maxToolCalls: 8 },
      { arkApiTurns: 2, inputTokens: 50_000, toolCalls: 9 },
    )).toBe("Per-execution tool-call limit exceeded (9/8)");
    expect(executionBudgetExceeded(
      { maxArkApiTurns: 8, maxInputTokens: 200_000, maxToolCalls: 8 },
      { arkApiTurns: 8, inputTokens: 200_000, toolCalls: 8 },
    )).toBeNull();
  });
  it("counts completed Ark turns once and preserves partial usage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telemetry-"));
    try {
      const directory = path.join(root, "sessions", "2026", "08", "31");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "rollout.jsonl");
      await writeFile(file, tokenEvent(15, 10, 4, 5) + "\n");
      const tracker = await CodexSessionTelemetryTracker.create(root);
      await appendFile(file, [
        tokenEvent(15, 10, 4, 5),
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command" } }),
        tokenEvent(34, 16, 8, 3),
        tokenEvent(34, 16, 8, 3),
        tokenEvent(55, 18, 9, 3),
        "",
      ].join("\n"));

      expect(await tracker.poll()).toMatchObject({
        inputTokens: 34,
        cachedInputTokens: 17,
        outputTokens: 6,
        arkApiTurns: 2,
        toolCalls: 1,
        peakContextTokens: 18,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flushes a final JSONL event even when the writer omitted a trailing newline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telemetry-"));
    try {
      const directory = path.join(root, "sessions", "2026", "08", "31");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "rollout.jsonl");
      await writeFile(file, "");
      const tracker = await CodexSessionTelemetryTracker.create(root);
      await appendFile(file, tokenEvent(20, 17, 6, 3));

      expect(await tracker.poll()).toMatchObject({ arkApiTurns: 0 });
      expect(await tracker.poll(true)).toMatchObject({
        inputTokens: 17,
        cachedInputTokens: 6,
        outputTokens: 3,
        arkApiTurns: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
