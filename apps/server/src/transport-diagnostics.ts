import { lookup } from "node:dns/promises";
import type { TransportDiagnostics } from "./types.js";

export function transportTarget(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

export function errorIdentity(error: unknown): { code: string | null; message: string } {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const cause = record?.cause;
  const causeRecord = cause && typeof cause === "object" ? cause as Record<string, unknown> : null;
  const code = typeof record?.code === "string"
    ? record.code
    : typeof causeRecord?.code === "string"
      ? causeRecord.code
      : null;
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = cause instanceof Error ? cause.message : null;
  return {
    code,
    message: causeMessage && !message.includes(causeMessage)
      ? `${message}: ${causeMessage}`
      : message,
  };
}

export async function diagnoseHostTransport(baseUrl: string): Promise<TransportDiagnostics> {
  const target = transportTarget(baseUrl);
  const startedAt = Date.now();
  let dnsAddress: string | null = null;
  try {
    dnsAddress = (await lookup(new URL(target).hostname)).address;
  } catch (error) {
    const identity = errorIdentity(error);
    return {
      checkedAt: new Date().toISOString(),
      target,
      dnsAddress,
      httpStatus: null,
      elapsedMs: Date.now() - startedAt,
      errorCode: identity.code,
      errorMessage: identity.message,
    };
  }
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return {
      checkedAt: new Date().toISOString(),
      target,
      dnsAddress,
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    const identity = errorIdentity(error);
    return {
      checkedAt: new Date().toISOString(),
      target,
      dnsAddress,
      httpStatus: null,
      elapsedMs: Date.now() - startedAt,
      errorCode: identity.code,
      errorMessage: identity.message,
    };
  }
}
