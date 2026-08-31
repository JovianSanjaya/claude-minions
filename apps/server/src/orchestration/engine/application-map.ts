import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ApplicationMapSummary } from "../contracts.js";

const excludedNames = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".cache",
  ".npm", ".npm-cache", ".pnpm-store", ".yarn-cache", ".parcel-cache", ".turbo",
  ".codex", ".orchestration", "orchestration-work", "protected-evaluators",
]);
const protectedSecretName = /(?:^|\/)[^/]*(?:private[-_]?key|credential|secret)[^/]*$/i;
const environmentName = /(?:^|\/)\.env(?:\..*)?$/i;
const safeEnvironmentTemplateName = /(?:^|\/)\.env\.(?:example|sample|template)$/i;
const generatedBuildArtifactName = /(?:^|\/)(?:[^/]+\.tsbuildinfo|\.eslintcache)$/i;
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

export function isSafeEnvironmentTemplatePath(relativePath: string): boolean {
  return safeEnvironmentTemplateName.test(relativePath.replaceAll(path.sep, "/"));
}

export function isProtectedEnvironmentPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, "/");
  return environmentName.test(normalized) && !safeEnvironmentTemplateName.test(normalized);
}

export function isApplicationMapExcluded(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, "/");
  return normalized.split("/").some((part) => excludedNames.has(part)) ||
    generatedBuildArtifactName.test(normalized) ||
    isProtectedEnvironmentPath(normalized) ||
    protectedSecretName.test(normalized);
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
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
    const inspected = await mapWithConcurrency(children, 32, async (child) => {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (isApplicationMapExcluded(relative)) return null;
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) return null;
      if (stats.isDirectory()) return { kind: "directory" as const, absolute, relative, child };
      if (!stats.isFile() || stats.size > 1_000_000) return null;
      return { kind: "file" as const, absolute, relative, child };
    });
    for (const candidate of inspected) {
      if (candidate?.kind === "directory") await walk(candidate.absolute);
    }
    const files = inspected.filter(
      (candidate): candidate is NonNullable<typeof candidate> & { kind: "file" } =>
        candidate?.kind === "file",
    );
    const mapped = await mapWithConcurrency(files, 16, async ({ absolute, relative, child }) => {
      const buffer = await readFile(absolute);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const source = textExtensions.has(path.extname(relative).toLowerCase())
        ? buffer.toString("utf8")
        : "";
      const facts = source ? inspectSource(relative, source) : { imports: [], exports: [], summary: `Binary asset ${relative}` };
      return {
        entry: { path: relative, sha256, bytes: buffer.byteLength, ...facts },
        packageBoundary: /^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(child.name)
          ? path.dirname(relative) === "." ? "." : path.dirname(relative)
          : null,
      };
    });
    for (const result of mapped) {
      entries.push(result.entry);
      if (result.packageBoundary !== null) packageBoundaries.push(result.packageBoundary);
    }
  };
  await walk(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
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
