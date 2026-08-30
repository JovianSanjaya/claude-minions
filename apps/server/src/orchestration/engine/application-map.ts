import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ApplicationMapSummary } from "../contracts.js";

/**
 * Deterministic, versioned application map.
 *
 * The map is built from inspectable repository facts (paths, hashes, imports,
 * exports, package boundaries) rather than model memory. Bounded semantic
 * summaries describe module ownership; filenames and signatures are never
 * recalled by a model when they can be read from disk.
 */

export interface MappedFile {
  path: string;
  sha256: string;
  bytes: number;
  imports: string[];
  exports: string[];
  symbols: string[];
}

export interface ApplicationMap {
  version: number;
  repositoryHash: string;
  createdAt: string;
  root: string;
  files: MappedFile[];
  directories: string[];
  packages: string[];
  /** path -> resolved relative paths it imports inside the workspace. */
  dependencyEdges: Record<string, string[]>;
  summary: string;
  fileCount: number;
  /** Relative paths changed since the previous map version. */
  changedFiles: string[];
}

/** Directory names never mapped, mounted, copied, or offered as context. */
export const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".codex",
  ".ssh",
  ".gnupg",
  ".deleted",
  ".orchestration",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Secret-shaped or credential file patterns that are never mapped. */
export const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /(^|\.)(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials(\.json|\.yaml|\.yml)?$/i,
  /^service-account.*\.json$/i,
  /\.secret(s)?(\..*)?$/i,
];

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".py",
  ".go",
  ".rs",
  ".sql",
  ".toml",
  ".sh",
]);

export const MAX_MAPPED_FILE_BYTES = 512 * 1024;
export const MAX_MAPPED_FILES = 2_000;

export function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export interface BuildApplicationMapOptions {
  /** Absolute paths that must never be mapped (for example the evaluator root). */
  protectedPaths?: string[];
  version?: number;
  previous?: ApplicationMap | null;
  now?: () => Date;
}

/**
 * Walks the workspace and produces a deterministic map. Symlinks that leave the
 * resolved workspace root, excluded directories, secret-shaped files, and files
 * outside the workspace are skipped.
 */
export async function buildApplicationMap(
  workspacePath: string,
  options: BuildApplicationMapOptions = {},
): Promise<ApplicationMap> {
  const root = await safeRealpath(path.resolve(workspacePath));
  const protectedRoots = await Promise.all(
    (options.protectedPaths ?? []).map((candidate) =>
      safeRealpath(path.resolve(candidate)),
    ),
  );
  const files: MappedFile[] = [];
  const directories: string[] = [];
  const packages: string[] = [];

  const walk = async (absolute: string, relative: string): Promise<void> => {
    if (files.length >= MAX_MAPPED_FILES) return;
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? relative + "/" + entry.name : entry.name;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (!(await isInsideRoot(childAbsolute, root, protectedRoots))) continue;
        directories.push(childRelative);
        await walk(childAbsolute, childRelative);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Only follow a symlink that stays inside the workspace boundary.
        if (!(await isInsideRoot(childAbsolute, root, protectedRoots))) continue;
        const stats = await lstat(childAbsolute).catch(() => null);
        if (!stats) continue;
      } else if (!entry.isFile()) {
        continue;
      }
      if (isExcludedFileName(entry.name)) continue;
      if (files.length >= MAX_MAPPED_FILES) return;
      const mapped = await mapFile(childAbsolute, childRelative);
      if (!mapped) continue;
      files.push(mapped);
      if (entry.name === "package.json") {
        packages.push(relative || ".");
      }
    }
  };

  await walk(root, "");
  files.sort((left, right) => left.path.localeCompare(right.path));

  const repositoryHash = hashManifest(files);
  const dependencyEdges = buildDependencyEdges(files);
  const version = options.version ?? (options.previous ? options.previous.version + 1 : 1);
  const changedFiles = options.previous ? diffFiles(options.previous.files, files) : [];
  const createdAt = (options.now?.() ?? new Date()).toISOString();

  return {
    version,
    repositoryHash,
    createdAt,
    root,
    files,
    directories: directories.sort(),
    packages: packages.sort(),
    dependencyEdges,
    summary: describeMap(files, directories, packages),
    fileCount: files.length,
    changedFiles,
  };
}

async function mapFile(absolute: string, relative: string): Promise<MappedFile | null> {
  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return null;
  }
  if (stats.size > MAX_MAPPED_FILE_BYTES) {
    return {
      path: relative,
      sha256: "oversized",
      bytes: stats.size,
      imports: [],
      exports: [],
      symbols: [],
    };
  }
  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch {
    return null;
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const extension = path.extname(relative).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) {
    return { path: relative, sha256, bytes: stats.size, imports: [], exports: [], symbols: [] };
  }
  return {
    path: relative,
    sha256,
    bytes: stats.size,
    imports: extractImports(content),
    exports: extractExports(content),
    symbols: extractSymbols(content),
  };
}

export function extractImports(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1];
      if (value) found.add(value);
    }
  }
  return [...found].sort().slice(0, 100);
}

export function extractExports(content: string): string[] {
  const found = new Set<string>();
  const pattern =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) {
    const value = match[1];
    if (value) found.add(value);
  }
  for (const match of content.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/).at(-1)?.trim();
      if (name) found.add(name);
    }
  }
  return [...found].sort().slice(0, 100);
}

export function extractSymbols(content: string): string[] {
  const found = new Set<string>();
  const pattern =
    /\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) {
    const value = match[1];
    if (value) found.add(value);
  }
  return [...found].sort().slice(0, 120);
}

function buildDependencyEdges(files: MappedFile[]): Record<string, string[]> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const edges: Record<string, string[]> = {};
  for (const file of files) {
    const resolved: string[] = [];
    for (const specifier of file.imports) {
      if (!specifier.startsWith(".")) continue;
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), specifier),
      );
      const candidates = [
        base,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
        base + ".ts",
        base + ".tsx",
        base + ".js",
        base + "/index.ts",
        base + "/index.js",
      ];
      const hit = candidates.find((candidate) => byPath.has(candidate));
      if (hit && !resolved.includes(hit)) resolved.push(hit);
    }
    if (resolved.length > 0) edges[file.path] = resolved.sort();
  }
  return edges;
}

export function hashManifest(files: Array<{ path: string; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(" ");
    hash.update(file.sha256);
    hash.update(" ");
  }
  return hash.digest("hex");
}

export function diffFiles(previous: MappedFile[], next: MappedFile[]): string[] {
  const before = new Map(previous.map((file) => [file.path, file.sha256]));
  const after = new Map(next.map((file) => [file.path, file.sha256]));
  const changed = new Set<string>();
  for (const [filePath, sha] of after) {
    if (before.get(filePath) !== sha) changed.add(filePath);
  }
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) changed.add(filePath);
  }
  return [...changed].sort();
}

function describeMap(
  files: MappedFile[],
  directories: string[],
  packages: string[],
): string {
  const topLevel = new Map<string, number>();
  for (const file of files) {
    const head = file.path.includes("/") ? (file.path.split("/")[0] as string) : ".";
    topLevel.set(head, (topLevel.get(head) ?? 0) + 1);
  }
  const areas = [...topLevel.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => name + " (" + count + " files)")
    .join(", ");
  return [
    files.length + " mapped files across " + directories.length + " directories",
    packages.length > 0 ? "package roots: " + packages.slice(0, 8).join(", ") : "no package manifests",
    areas ? "areas: " + areas : "",
  ]
    .filter(Boolean)
    .join(". ");
}

export function toApplicationMapSummary(
  map: ApplicationMap,
  orchestrationId: string,
): ApplicationMapSummary {
  return {
    orchestrationId,
    version: map.version,
    repositoryHash: map.repositoryHash,
    summary: map.summary.slice(0, 2_000),
    fileCount: map.fileCount,
    createdAt: map.createdAt,
  };
}

/** Compact, model-facing rendering. Paths and symbols only - never file bodies. */
export function renderMapForModel(map: ApplicationMap, maxFiles = 120): string {
  const lines = [
    "Application map version " + map.version + " (hash " + map.repositoryHash.slice(0, 12) + ")",
    map.summary,
    "",
    "Files:",
  ];
  for (const file of map.files.slice(0, maxFiles)) {
    const symbols = file.symbols.slice(0, 6).join(", ");
    lines.push("- " + file.path + (symbols ? " [" + symbols + "]" : ""));
  }
  if (map.files.length > maxFiles) {
    lines.push("- ... " + (map.files.length - maxFiles) + " more files not listed");
  }
  return lines.join("\n");
}

async function safeRealpath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}

async function isInsideRoot(
  candidate: string,
  root: string,
  protectedRoots: string[],
): Promise<boolean> {
  const resolved = await safeRealpath(candidate);
  if (protectedRoots.some((protectedRoot) => isWithin(resolved, protectedRoot))) {
    return false;
  }
  return isWithin(resolved, root);
}

export function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
