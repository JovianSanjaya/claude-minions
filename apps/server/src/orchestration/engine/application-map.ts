import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ApplicationMapSummary } from "../contracts.js";

const excludedNames = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".cache",
  ".codex", ".orchestration", "orchestration-work", "protected-evaluators",
]);
const protectedName = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*(?:private[-_]?key|credential|secret)[^/]*)$/i;
const textExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".py",
  ".go", ".rs", ".java", ".kt", ".css", ".scss", ".html", ".yaml", ".yml",
  ".toml", ".sh", ".sql", ".graphql",
]);

export interface ApplicationMapEntry {
  path: string;
  sha256: string;
  bytes: number;
  imports: string[];
  exports: string[];
  summary: string;
}

export interface DetailedApplicationMap {
  summary: ApplicationMapSummary;
  entries: ApplicationMapEntry[];
  packageBoundaries: string[];
}

export function isApplicationMapExcluded(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, "/");
  return normalized.split("/").some((part) => excludedNames.has(part)) || protectedName.test(normalized);
}

function semanticSummary(relativePath: string, source: string): string {
  const heading = source.match(/^#\s+(.+)$/m)?.[1];
  const symbols = [...source.matchAll(/\b(?:class|interface|type|function)\s+([A-Za-z_$][\w$]*)/g)]
    .slice(0, 8)
    .map((match) => match[1]);
  return [heading, symbols.length ? `Symbols: ${symbols.join(", ")}` : null]
    .filter(Boolean)
    .join(". ") || `Source module ${relativePath}`;
}

function inspectSource(relativePath: string, source: string) {
  const imports = [...source.matchAll(/(?:from\s+|require\s*\(|import\s*\()\s*["']([^"']+)/g)]
    .slice(0, 100)
    .map((match) => match[1]!);
  const exports = [...source.matchAll(/\bexport\s+(?:default\s+)?(?:class|function|interface|type|const|let|var)?\s*([A-Za-z_$][\w$]*)?/g)]
    .slice(0, 100)
    .map((match) => match[1] ?? "default");
  return { imports, exports, summary: semanticSummary(relativePath, source) };
}

export async function buildApplicationMap(
  workspacePath: string,
  orchestrationId: string,
  version = 1,
  now = new Date(),
): Promise<DetailedApplicationMap> {
  const root = await realpath(workspacePath);
  const entries: ApplicationMapEntry[] = [];
  const packageBoundaries: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (isApplicationMapExcluded(relative)) continue;
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stats.isFile() || stats.size > 1_000_000) continue;
      const buffer = await readFile(absolute);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const source = textExtensions.has(path.extname(relative).toLowerCase())
        ? buffer.toString("utf8")
        : "";
      const facts = source ? inspectSource(relative, source) : { imports: [], exports: [], summary: `Binary asset ${relative}` };
      entries.push({ path: relative, sha256, bytes: buffer.byteLength, ...facts });
      if (/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(child.name)) {
        packageBoundaries.push(path.dirname(relative) === "." ? "." : path.dirname(relative));
      }
    }
  };
  await walk(root);
  const repositoryHash = createHash("sha256")
    .update(entries.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"))
    .digest("hex");
  return {
    entries,
    packageBoundaries: [...new Set(packageBoundaries)].sort(),
    summary: {
      orchestrationId,
      version,
      repositoryHash,
      summary: `${entries.length} mapped files across ${packageBoundaries.length || 1} package boundary/boundaries`,
      fileCount: entries.length,
      createdAt: now.toISOString(),
    },
  };
}
