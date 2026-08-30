import type { Agent, AgentRun, Message, SystemInfo } from "./types";
import type {
  ConfirmIntentInput,
  CreateBenchmarkInput,
  CreateOrchestrationInput,
  OrchestrationApi,
  ReviseIntentInput,
} from "./orchestration/api-port";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
};

/**
 * Typed adapter over Task 1's orchestration routes and Task 3's benchmark
 * routes, reusing the same authenticated `request` helper and bearer token
 * as the rest of this file. Passed into `OrchestrationPanel` as its `api`
 * prop; see apps/web/src/orchestration/api-port.ts for the interface this
 * implements and the exact response shapes.
 */
export const orchestrationApi: OrchestrationApi = {
  createOrchestration: (agentId, input: CreateOrchestrationInput) =>
    request("/api/agents/" + agentId + "/orchestrations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listOrchestrations: (agentId) =>
    request("/api/agents/" + agentId + "/orchestrations"),
  getOrchestration: (orchestrationId) =>
    request("/api/orchestrations/" + orchestrationId),
  reviseIntent: (orchestrationId, input: ReviseIntentInput) =>
    request("/api/orchestrations/" + orchestrationId + "/intent", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  confirmIntent: (orchestrationId, input: ConfirmIntentInput) =>
    request("/api/orchestrations/" + orchestrationId + "/confirm", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startOrchestration: (orchestrationId) =>
    request("/api/orchestrations/" + orchestrationId + "/start", {
      method: "POST",
    }),
  cancelOrchestration: (orchestrationId, reason) =>
    request("/api/orchestrations/" + orchestrationId + "/cancel", {
      method: "POST",
      ...(reason ? { body: JSON.stringify({ reason }) } : {}),
    }),
  confirmAmendment: (orchestrationId, amendmentId) =>
    request(
      "/api/orchestrations/" + orchestrationId + "/amendments/" + amendmentId + "/confirm",
      { method: "POST" },
    ),
  rejectAmendment: (orchestrationId, amendmentId, reason) =>
    request(
      "/api/orchestrations/" + orchestrationId + "/amendments/" + amendmentId + "/reject",
      { method: "POST", ...(reason ? { body: JSON.stringify({ reason }) } : {}) },
    ),
  createBenchmark: (agentId, input: CreateBenchmarkInput) =>
    request("/api/agents/" + agentId + "/benchmarks", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getBenchmark: (benchmarkId) => request("/api/benchmarks/" + benchmarkId),
  cancelBenchmark: (benchmarkId) =>
    request("/api/benchmarks/" + benchmarkId + "/cancel", { method: "POST" }),
  listEvents: (orchestrationId) =>
    request("/api/orchestrations/" + orchestrationId + "/events"),
  listTasks: (orchestrationId) =>
    request("/api/orchestrations/" + orchestrationId + "/tasks"),
  listArtifacts: (orchestrationId) =>
    request("/api/orchestrations/" + orchestrationId + "/artifacts"),
  listVerifications: (orchestrationId) =>
    request("/api/orchestrations/" + orchestrationId + "/verifications"),
};
