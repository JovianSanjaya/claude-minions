import type { Agent, AgentRun, Message, SystemInfo } from "./types";
import type { OrchestrationApi } from "./orchestration/api-port";

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

export const orchestrationApi: OrchestrationApi = {
  list: (agentId) => request(`/api/agents/${agentId}/orchestrations`),
  create: (agentId, input) => request(`/api/agents/${agentId}/orchestrations`, { method: "POST", body: JSON.stringify(input) }),
  get: (id) => request(`/api/orchestrations/${id}`),
  reviseIntent: (id, revision) => request(`/api/orchestrations/${id}/intent`, { method: "PATCH", body: JSON.stringify({ revision }) }),
  confirm: (id, criteria, answers) => request(`/api/orchestrations/${id}/confirm`, {
    method: "POST",
    body: JSON.stringify({
      ...(criteria ? { criteria } : {}),
      ...(answers?.length ? { answers } : {}),
    }),
  }),
  start: (id) => request(`/api/orchestrations/${id}/start`, { method: "POST" }),
  cancel: (id) => request(`/api/orchestrations/${id}/cancel`, { method: "POST" }),
  recover: (id) => request(`/api/orchestrations/${id}/recover`, { method: "POST" }),
  retryVerification: (id) => request(`/api/orchestrations/${id}/retry-verification`, { method: "POST" }),
  confirmAmendment: (id, amendmentId, response) => request(`/api/orchestrations/${id}/amendments/${amendmentId}/confirm`, {
    method: "POST",
    body: JSON.stringify(response ? { response } : {}),
  }),
  rejectAmendment: (id, amendmentId) => request(`/api/orchestrations/${id}/amendments/${amendmentId}/reject`, { method: "POST" }),
  createBenchmark: (agentId, input) => request(`/api/agents/${agentId}/benchmarks`, { method: "POST", body: JSON.stringify(input) }),
  getBenchmark: (id) => request(`/api/benchmarks/${id}`),
};
