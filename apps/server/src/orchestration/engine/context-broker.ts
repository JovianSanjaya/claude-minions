import path from "node:path";
import type { ContextPacketSummary } from "../contracts.js";
import type { ApplicationMap } from "./application-map.js";
import { isPathWithinAllowed } from "./worker-workspaces.js";

export interface ContextPacket {
  summary: ContextPacketSummary;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

/**
 * Builds the minimum-sufficient context packet for one task: only the
 * application-map files that fall under its allowed paths, plus the
 * interfaces those files export. Full source is never duplicated into the
 * orchestration database — only hashes, paths, and a byte/token estimate
 * are persisted as evidence (`sink.recordContextPacket`).
 */
export function buildContextPacket(
  taskId: string,
  applicationMap: ApplicationMap,
  contractVersion: number,
  allowedPaths: string[],
  artifactVersions: Record<string, number>,
): ContextPacket {
  const files = applicationMap.files.filter((file) => isPathWithinAllowed(file.path, allowedPaths));
  const relevantInterfaces = [...new Set(files.flatMap((file) => file.exports))].sort();
  const estimatedTokens = files.reduce((sum, file) => sum + Math.ceil(file.bytes / 4), 0);

  return {
    summary: {
      taskId,
      applicationMapVersion: applicationMap.summary.version,
      contractVersion,
      sourceFiles: files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
      relevantInterfaces,
      artifactVersions,
      estimatedTokens,
    },
    files: files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
  };
}

export function summarizeContext(packet: ContextPacket): string {
  if (packet.files.length === 0) {
    return "No source files matched this task's allowed paths.";
  }
  return `${packet.files.length} file(s): ${packet.files.map((file) => file.path).join(", ")}`;
}

export interface ExpansionRequest {
  requestedPath: string;
  reason: string;
}

export type ExpansionDecision =
  | { allowed: true; resolvedRelativePath: string }
  | { allowed: false; reason: string };

const PROTECTED_PATH_PATTERNS = [
  /(^|\/)\.env/,
  /(^|\/)\.git(\/|$)/,
  /node_modules/,
  /\.orchestration-tmp/,
  /protected-evaluators/,
];

/**
 * Validates a worker's narrow context-expansion request: blocks path
 * traversal, symlink-style escapes (via path resolution against the
 * workspace root), and protected paths, and enforces the per-task expansion
 * budget. The goal is minimum *sufficient* context, not minimum *possible*
 * context, so this allows a request through as long as it resolves inside
 * the workspace and isn't protected — it does not second-guess whether the
 * file is actually relevant.
 */
export function resolveExpansion(
  workspacePath: string,
  request: ExpansionRequest,
  usedExpansions: number,
  maxExpansionsPerTask: number,
): ExpansionDecision {
  if (usedExpansions >= maxExpansionsPerTask) {
    return { allowed: false, reason: "Context expansion budget exhausted for this task" };
  }
  const normalizedRequested = request.requestedPath.replace(/^\/+/, "");
  if (PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalizedRequested))) {
    return { allowed: false, reason: "Requested path is protected" };
  }
  const resolvedAbsolute = path.resolve(workspacePath, normalizedRequested);
  const relativeToWorkspace = path.relative(workspacePath, resolvedAbsolute);
  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    return { allowed: false, reason: "Requested path escapes the task workspace" };
  }
  return { allowed: true, resolvedRelativePath: relativeToWorkspace.split(path.sep).join("/") };
}
