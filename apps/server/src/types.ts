export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /**
   * Distinguishes concurrent calls for the same Agent — e.g. several
   * orchestration workers running in isolated workspace copies under one
   * Agent. When omitted, runner implementations key their internal active-
   * process bookkeeping by `agentId` alone (the original, single-run
   * behavior), so direct Playground execution is unaffected.
   */
  executionId?: string | undefined;
  /**
   * Restricts this call's sandbox mode below the server's configured
   * default (e.g. a read-only worker preflight before any writable
   * execution). Never widens it — a request cannot use this to escalate
   * past `CODEX_SANDBOX_MODE`; runner implementations that don't support a
   * per-call override simply ignore it and use the configured default.
   */
  sandboxMode?: "read-only" | "workspace-write" | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  /**
   * Cancels the active run(s) for an Agent. With `executionId`, cancels only
   * that specific execution; without it, cancels every currently active
   * execution for the Agent (the original behavior when only one exists).
   */
  cancel(agentId: string, executionId?: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
