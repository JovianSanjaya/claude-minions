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

/**
 * Adapts the same authenticated `request()` helper above to Task 3's
 * `OrchestrationApi` port — one thin wrapper per method, mapping 1:1 to the
 * routes registered by `registerOrchestrationRoutes`/`registerBenchmarkRoutes`.
 */
export const orchestrationApi: OrchestrationApi = {
  create: (agentId, body) =>
    request(`/api/agents/${agentId}/orchestrations`, { method: "POST", body: JSON.stringify(body) }),
  list: (agentId) => request(`/api/agents/${agentId}/orchestrations`),
  get: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}`),
  reviseIntent: (orchestrationId, note) =>
    request(`/api/orchestrations/${orchestrationId}/intent`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }),
  answerClarification: (orchestrationId, questionId, answer) =>
    request(`/api/orchestrations/${orchestrationId}/intent/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify(answer),
    }),
  confirm: (orchestrationId, criteria) =>
    request(`/api/orchestrations/${orchestrationId}/confirm`, {
      method: "POST",
      body: JSON.stringify(criteria ? { criteria } : {}),
    }),
  proposeAmendment: (orchestrationId, body) =>
    request(`/api/orchestrations/${orchestrationId}/amendments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  confirmAmendment: (orchestrationId, amendmentId) =>
    request(`/api/orchestrations/${orchestrationId}/amendments/${amendmentId}/confirm`, { method: "POST" }),
  rejectAmendment: (orchestrationId, amendmentId) =>
    request(`/api/orchestrations/${orchestrationId}/amendments/${amendmentId}/reject`, { method: "POST" }),
  start: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}/start`, { method: "POST" }),
  cancel: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}/cancel`, { method: "POST" }),
  events: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}/events`),
  tasks: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}/tasks`),
  artifacts: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}/artifacts`),
  verifications: (orchestrationId) => request(`/api/orchestrations/${orchestrationId}/verifications`),
  createBenchmark: (agentId, body) =>
    request(`/api/agents/${agentId}/benchmarks`, { method: "POST", body: JSON.stringify(body) }),
  getBenchmark: (benchmarkId) => request(`/api/benchmarks/${benchmarkId}`),
};
