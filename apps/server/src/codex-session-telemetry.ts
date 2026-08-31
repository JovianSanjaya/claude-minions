import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RunUsage } from "./types.js";

interface FileCursor {
  offset: number;
  remainder: string;
  lastTotal: string | null;
}

function tokenTuple(value: Record<string, unknown>): string {
  return [
    value.input_tokens,
    value.cached_input_tokens,
    value.output_tokens,
    value.total_tokens,
  ].join(":");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function sessionFiles(root: string): Promise<string[]> {
  const sessions = path.join(root, "sessions");
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(absolute);
    }
  };
  await visit(sessions);
  return found.sort();
}

async function lastTokenTotal(file: string): Promise<string | null> {
  const source = await readFile(file, "utf8").catch(() => "");
  for (const line of source.split(/\r?\n/).reverse()) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const payload = event.payload && typeof event.payload === "object"
        ? event.payload as Record<string, unknown>
        : null;
      const info = payload?.info && typeof payload.info === "object"
        ? payload.info as Record<string, unknown>
        : null;
      const total = info?.total_token_usage && typeof info.total_token_usage === "object"
        ? info.total_token_usage as Record<string, unknown>
        : null;
      if (event.type === "event_msg" && payload?.type === "token_count" && total) {
        return tokenTuple(total);
      }
    } catch {
      continue;
    }
  }
  return null;
}

export interface CodexSessionTelemetry extends Required<Pick<
  RunUsage,
  "inputTokens" | "cachedInputTokens" | "outputTokens" | "arkApiTurns" |
  "toolCalls" | "streamRetries" | "peakContextTokens"
>> {
  lastEventAt: string | null;
}

export interface ExecutionTelemetryLimits {
  maxArkApiTurns?: number | undefined;
  maxInputTokens?: number | undefined;
  maxToolCalls?: number | undefined;
}

export function executionBudgetExceeded(
  limits: ExecutionTelemetryLimits,
  telemetry: Pick<CodexSessionTelemetry, "arkApiTurns" | "inputTokens" | "toolCalls">,
): string | null {
  // Telemetry for a completed turn/tool can be persisted just before Codex
  // emits its final agent message. Stopping at equality kills a valid final
  // response at the boundary, so terminate only after the allowance is
  // actually exceeded.
  if (limits.maxArkApiTurns && telemetry.arkApiTurns > limits.maxArkApiTurns) {
    return `Ark-turn limit exceeded (${telemetry.arkApiTurns}/${limits.maxArkApiTurns})`;
  }
  if (limits.maxInputTokens && telemetry.inputTokens > limits.maxInputTokens) {
    return `Per-execution input-token limit exceeded (${telemetry.inputTokens}/${limits.maxInputTokens})`;
  }
  if (limits.maxToolCalls && telemetry.toolCalls > limits.maxToolCalls) {
    return `Per-execution tool-call limit exceeded (${telemetry.toolCalls}/${limits.maxToolCalls})`;
  }
  return null;
}

const emptyTelemetry = (): CodexSessionTelemetry => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  arkApiTurns: 0,
  toolCalls: 0,
  streamRetries: 0,
  peakContextTokens: 0,
  lastEventAt: null,
});

export class CodexSessionTelemetryTracker {
  private readonly cursors = new Map<string, FileCursor>();
  private readonly telemetry = emptyTelemetry();

  private constructor(private readonly runtimeHomePath: string) {}

  static async create(runtimeHomePath: string): Promise<CodexSessionTelemetryTracker> {
    const tracker = new CodexSessionTelemetryTracker(runtimeHomePath);
    for (const file of await sessionFiles(runtimeHomePath)) {
      const info = await stat(file);
      tracker.cursors.set(file, {
        offset: info.size,
        remainder: "",
        lastTotal: await lastTokenTotal(file),
      });
    }
    return tracker;
  }

  async poll(flushRemainders = false): Promise<CodexSessionTelemetry> {
    for (const file of await sessionFiles(this.runtimeHomePath)) {
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cursor = this.cursors.get(file) ?? { offset: 0, remainder: "", lastTotal: null };
      this.cursors.set(file, cursor);
      if (info.size <= cursor.offset) continue;
      const length = info.size - cursor.offset;
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, cursor.offset);
        cursor.offset = info.size;
        const lines = (cursor.remainder + buffer.toString("utf8")).split(/\r?\n/);
        cursor.remainder = lines.pop() ?? "";
        for (const line of lines) this.consume(line, cursor);
      } finally {
        await handle.close();
      }
    }
    if (flushRemainders) {
      for (const cursor of this.cursors.values()) {
        if (!cursor.remainder.trim()) continue;
        this.consume(cursor.remainder, cursor);
        cursor.remainder = "";
      }
    }
    return this.snapshot();
  }

  snapshot(): CodexSessionTelemetry {
    return { ...this.telemetry };
  }

  private consume(line: string, cursor: FileCursor): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof event.timestamp === "string") this.telemetry.lastEventAt = event.timestamp;
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : null;
    if (event.type === "response_item" && payload?.type === "function_call") {
      this.telemetry.toolCalls += 1;
    }
    if (
      (event.type === "event_msg" || event.type === "response_item") &&
      /retry|reconnect/i.test(String(payload?.type ?? ""))
    ) {
      this.telemetry.streamRetries += 1;
    }
    if (event.type !== "event_msg" || payload?.type !== "token_count") return;
    const info = payload.info && typeof payload.info === "object"
      ? payload.info as Record<string, unknown>
      : null;
    const total = info?.total_token_usage && typeof info.total_token_usage === "object"
      ? info.total_token_usage as Record<string, unknown>
      : null;
    const last = info?.last_token_usage && typeof info.last_token_usage === "object"
      ? info.last_token_usage as Record<string, unknown>
      : null;
    if (!total || !last) return;
    const tuple = tokenTuple(total);
    if (tuple === cursor.lastTotal) return;
    cursor.lastTotal = tuple;
    this.telemetry.arkApiTurns += 1;
    const inputTokens = numberValue(last.input_tokens);
    this.telemetry.inputTokens += inputTokens;
    this.telemetry.cachedInputTokens += numberValue(last.cached_input_tokens);
    this.telemetry.outputTokens += numberValue(last.output_tokens);
    this.telemetry.peakContextTokens = Math.max(this.telemetry.peakContextTokens, inputTokens);
  }
}
