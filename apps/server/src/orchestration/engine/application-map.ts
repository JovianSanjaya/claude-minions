import { createHash } from "node:crypto";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ApplicationMapSummary } from "../contracts.js";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".data",
  "codex-home",
  ".orchestration",
  ".orchestrations",
]);
const SECRET_FILE = /(^|\/)(\.env(?:\..*)?|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i;
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|md|css|scss|html|yml|yaml|toml|tf|sh|py|go|rs|java|kt|sql|graphql|proto)$/i;

export interface ApplicationMapFile {
  path: string;
  sha256: string;
  bytes: number;
  imports: string[];
  exports: string[];
}

export interface ApplicationMap {
  rootPath: string;
  summary: ApplicationMapSummary;
  files: ApplicationMapFile[];
  packageBoundaries: string[];
  moduleSummaries: string[];
}

export interface ApplicationMapOptions {
  version?: number;
  maxFiles?: number;
  maxFileBytes?: number;
}

export function isProtectedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return true;
  if (SECRET_FILE.test(normalized)) return true;
  return normalized.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inspectModule(content: string): Pick<ApplicationMapFile, "imports" | "exports"> {
  const imports = [...content.matchAll(/(?:import|require\s*\()\s*(?:[^"']*?from\s*)?["']([^"']+)["']/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .slice(0, 50);
  const exports = [...content.matchAll(/export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)?\s*([A-Za-z_$][\w$]*)?/g)]
    .map((match) => match[1] ?? "default")
    .slice(0, 50);
  return { imports: [...new Set(imports)], exports: [...new Set(exports)] };
}

export class ApplicationMapBuilder {
  async build(
    orchestrationId: string,
    workspacePath: string,
    options: ApplicationMapOptions = {},
  ): Promise<ApplicationMap> {
    const rootPath = await realpath(workspacePath);
    const maxFiles = options.maxFiles ?? 5_000;
    const maxFileBytes = options.maxFileBytes ?? 512_000;
    const paths: string[] = [];

    const visit = async (directory: string): Promise<void> => {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (paths.length >= maxFiles) break;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(rootPath, absolute).replaceAll(path.sep, "/");
        if (isProtectedRelativePath(relative)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) paths.push(relative);
      }
    };
    await visit(rootPath);
    paths.sort();

    const files: ApplicationMapFile[] = [];
    for (const relative of paths) {
      const absolute = path.join(rootPath, relative);
      const info = await stat(absolute);
      const content = await readFile(absolute);
      const moduleInfo =
        info.size <= maxFileBytes && TEXT_FILE.test(relative)
          ? inspectModule(content.toString("utf8"))
          : { imports: [], exports: [] };
      files.push({
        path: relative,
        sha256: sha256(content),
        bytes: info.size,
        ...moduleInfo,
      });
    }

    const packageBoundaries = files
      .filter((file) => /(^|\/)package\.json$/.test(file.path))
      .map((file) => path.posix.dirname(file.path));
    const directories = new Map<string, number>();
    for (const file of files) {
      const directory = path.posix.dirname(file.path);
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
    const moduleSummaries = [...directories]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 80)
      .map(([directory, count]) => `${directory === "." ? "root" : directory}: ${count} files`);
    const repositoryHash = sha256(
      files.map((file) => `${file.path}\0${file.sha256}\0${file.bytes}`).join("\n"),
    );
    const version = options.version ?? 1;
    const summary: ApplicationMapSummary = {
      orchestrationId,
      version,
      repositoryHash,
      summary: [
        `${files.length} mapped files across ${directories.size} directories.`,
        packageBoundaries.length
          ? `Package boundaries: ${packageBoundaries.join(", ")}.`
          : "No package manifest boundary detected.",
      ].join(" "),
      fileCount: files.length,
      createdAt: new Date().toISOString(),
    };
    return { rootPath, summary, files, packageBoundaries, moduleSummaries };
  }
}
