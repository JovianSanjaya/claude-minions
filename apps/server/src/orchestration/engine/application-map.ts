import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ApplicationMapSummary } from "../contracts.js";

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".data",
  ".cache",
  ".orchestration-tmp",
]);
const EXCLUDED_FILE_PATTERNS = [/^\.env/, /\.pem$/, /\.key$/i, /credentials/i, /^\.git/];
const SOURCE_EXTENSION_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IMPORT_PATTERN = /(?:import|export)\s+(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_NAME_PATTERN = /export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z0-9_]+)/g;
const MAX_SCANNED_FILE_BYTES = 2_000_000;

export interface ApplicationMapFile {
  path: string;
  sha256: string;
  bytes: number;
  imports: string[];
  exports: string[];
}

export interface ApplicationMap {
  summary: ApplicationMapSummary;
  files: ApplicationMapFile[];
  directories: string[];
}

function extractImportsExports(content: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];
  IMPORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_PATTERN.exec(content))) {
    const specifier = match[1];
    if (specifier) imports.push(specifier);
  }
  EXPORT_NAME_PATTERN.lastIndex = 0;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = EXPORT_NAME_PATTERN.exec(content))) {
    const name = nameMatch[1];
    if (name) exports.push(name);
  }
  return { imports, exports };
}

async function walk(
  root: string,
  current: string,
  files: ApplicationMapFile[],
  directories: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      const nextDir = path.join(current, entry.name);
      directories.add(path.relative(root, nextDir));
      await walk(root, nextDir, files, directories);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
    const fullPath = path.join(current, entry.name);
    let info;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }
    if (info.size > MAX_SCANNED_FILE_BYTES) continue;

    let imports: string[] = [];
    let exports: string[] = [];
    let hashSource: string;
    if (SOURCE_EXTENSION_PATTERN.test(entry.name)) {
      try {
        const content = await readFile(fullPath, "utf8");
        ({ imports, exports } = extractImportsExports(content));
        hashSource = content;
      } catch {
        hashSource = `${info.size}:${info.mtimeMs}`;
      }
    } else {
      hashSource = `${info.size}:${info.mtimeMs}`;
    }
    files.push({
      path: path.relative(root, fullPath),
      sha256: createHash("sha256").update(hashSource).digest("hex"),
      bytes: info.size,
      imports,
      exports,
    });
  }
}

/**
 * Deterministic, versioned repository facts: no model call, no memory —
 * every file/import/export/hash here is read directly off disk. Bounded
 * semantic summarization (what a module is *for*) would be the model's job
 * in a fuller build; this restricted build keeps the summary text
 * deterministic (file/directory counts) rather than fabricate a semantic
 * description without a live model call backing it.
 */
export async function buildApplicationMap(
  orchestrationId: string,
  workspacePath: string,
  version: number,
): Promise<ApplicationMap> {
  const files: ApplicationMapFile[] = [];
  const directories = new Set<string>();
  await walk(workspacePath, workspacePath, files, directories);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const repositoryHash = createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.sha256}`).join("\n"))
    .digest("hex");

  const topLevelDirs = [...directories].filter((dir) => !dir.includes(path.sep)).sort();
  const summary: ApplicationMapSummary = {
    orchestrationId,
    version,
    repositoryHash,
    summary:
      `${files.length} file(s) across ${topLevelDirs.length || (files.length > 0 ? 1 : 0)} top-level area(s)` +
      (topLevelDirs.length > 0 ? `: ${topLevelDirs.slice(0, 8).join(", ")}` : ""),
    fileCount: files.length,
    createdAt: new Date().toISOString(),
  };

  return { summary, files, directories: [...directories].sort() };
}

export function topLevelDirectory(relativePath: string): string | null {
  const separatorIndex = relativePath.indexOf(path.sep === "\\" ? "\\" : "/");
  if (separatorIndex === -1) return null;
  return relativePath.slice(0, separatorIndex);
}
