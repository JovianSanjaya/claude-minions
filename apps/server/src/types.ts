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

/**
 * Sandbox modes an orchestrated execution may request. Deliberately narrower
 * than the platform-wide `CODEX_SANDBOX_MODE`: orchestration never grants
 * `danger-full-access`.
 */
export type ExecutionSandboxMode = "read-only" | "workspace-write";

/**
 * Logical model role. Structurally identical to `ModelRole` in
 * `orchestration/contracts.ts`; duplicated here so the baseline runtime types
 * do not depend on the orchestration module.
 */
export type ExecutionRole = "planner" | "worker" | "verifier" | "integrator";

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /**
   * Stable identifier for this single child execution. Direct Playground runs
   * pass the Run ID; orchestrated calls pass a per-role execution ID. Runners
   * key their active-process/container tables on this value so one Agent (or
   * one orchestration) can own several concurrent child executions.
   */
  executionId: string;
  orchestrationId?: string | undefined;
  taskId?: string | undefined;
  role?: ExecutionRole | undefined;
  /** Trusted, server-resolved model ID. Never a browser-supplied value. */
  modelId?: string | undefined;
  /** Trusted, server-resolved Codex/Runtime state directory for this role. */
  runtimeHomePath?: string | undefined;
  sandboxMode?: ExecutionSandboxMode | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  /** Cancels one execution by its `executionId`. */
  cancel(executionId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

/**
 * Optional port that lets `AgentService` cooperate with the orchestration
 * control plane so direct and orchestrated execution cannot race on the same
 * Agent workspace. Final Assembly injects the Task 1 adapter; when omitted a
 * no-op implementation is used and baseline behavior is unchanged.
 */
export interface AgentExecutionCoordinator {
  /** Throws (typically HttpError 409) when orchestration owns the workspace. */
  assertAgentAvailableForDirect(agentId: string): Promise<void>;
  hasActiveOrchestration(agentId: string): Promise<boolean>;
  /** Cancels orchestration work for this Agent and waits for reconciliation. */
  cancelForAgent(agentId: string): Promise<void>;
}

export const noopAgentExecutionCoordinator: AgentExecutionCoordinator = {
  async assertAgentAvailableForDirect(): Promise<void> {},
  async hasActiveOrchestration(): Promise<boolean> {
    return false;
  },
  async cancelForAgent(): Promise<void> {},
};
