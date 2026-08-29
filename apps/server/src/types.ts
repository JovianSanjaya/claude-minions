import type { ModelRole } from "./orchestration/contracts.js";

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
  modelId?: string | undefined;
  modelFallback?: boolean | undefined;
}

export interface RunnerRequest {
  executionId: string;
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  orchestrationId?: string | undefined;
  taskId?: string | undefined;
  role?: ModelRole | undefined;
  modelId?: string | undefined;
  runtimeHomePath?: string | undefined;
  sandboxMode?: "read-only" | "workspace-write" | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(executionId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export interface AgentExecutionCoordinator {
  assertAgentAvailableForDirect(agentId: string): Promise<void>;
  hasActiveOrchestration(agentId: string): Promise<boolean>;
  cancelForAgent(agentId: string): Promise<boolean>;
}
