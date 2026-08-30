import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildApplicationMap,
  diffFiles,
  extractExports,
  extractImports,
  renderMapForModel,
  toApplicationMapSummary,
} from "./application-map.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "map-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src", "api"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(
    path.join(root, "src", "api", "reset.ts"),
    'import { Token } from "../schema.js";\nexport function reset(): Token { return {} as Token; }\n',
  );
  await writeFile(
    path.join(root, "src", "schema.ts"),
    "export interface Token { id: string }\n",
  );
  await writeFile(path.join(root, "package.json"), '{ "name": "demo" }\n');
  await writeFile(path.join(root, ".env"), "ARK_API_KEY=super-secret\n");
  await writeFile(path.join(root, "server.key"), "-----BEGIN PRIVATE KEY-----\n");
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports=1\n");
  await writeFile(path.join(root, ".git", "config"), "[core]\n");
  await writeFile(path.join(root, "dist", "bundle.js"), "console.log(1)\n");
  return root;
}

describe("deterministic application map", () => {
  it("excludes VCS, dependency, build and credential files", async () => {
    const root = await makeWorkspace();
    const map = await buildApplicationMap(root);
    const paths = map.files.map((file) => file.path);
    expect(paths).toContain("src/api/reset.ts");
    expect(paths).toContain("package.json");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("server.key");
    expect(paths.some((candidate) => candidate.startsWith("node_modules"))).toBe(false);
    expect(paths.some((candidate) => candidate.startsWith(".git"))).toBe(false);
    expect(paths.some((candidate) => candidate.startsWith("dist"))).toBe(false);
  });

  it("never maps a protected evaluator root inside the workspace", async () => {
    const root = await makeWorkspace();
    await mkdir(path.join(root, "protected"), { recursive: true });
    await writeFile(path.join(root, "protected", "acceptance.json"), "[]");
    const map = await buildApplicationMap(root, {
      protectedPaths: [path.join(root, "protected")],
    });
    expect(map.files.some((file) => file.path.startsWith("protected"))).toBe(false);
  });

  it("does not follow a symlink that escapes the workspace", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(path.join(tmpdir(), "map-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    await symlink(outside, path.join(root, "escape"));
    const map = await buildApplicationMap(root);
    expect(map.files.some((file) => file.path.startsWith("escape"))).toBe(false);
  });

  it("is deterministic, versioned, and reports changed files", async () => {
    const root = await makeWorkspace();
    const first = await buildApplicationMap(root);
    const repeat = await buildApplicationMap(root);
    expect(repeat.repositoryHash).toBe(first.repositoryHash);
    expect(first.version).toBe(1);

    await writeFile(
      path.join(root, "src", "schema.ts"),
      "export interface Token { id: string; expiresAt: string }\n",
    );
    const second = await buildApplicationMap(root, { previous: first });
    expect(second.version).toBe(2);
    expect(second.repositoryHash).not.toBe(first.repositoryHash);
    expect(second.changedFiles).toEqual(["src/schema.ts"]);
    expect(diffFiles(first.files, second.files)).toEqual(["src/schema.ts"]);
  });

  it("records deterministic imports, exports and dependency edges", async () => {
    const root = await makeWorkspace();
    const map = await buildApplicationMap(root);
    expect(extractImports('import { a } from "./b.js";')).toEqual(["./b.js"]);
    expect(extractExports("export interface Token { id: string }")).toEqual(["Token"]);
    expect(map.dependencyEdges["src/api/reset.ts"]).toEqual(["src/schema.ts"]);
  });

  it("renders paths and symbols but never file bodies", async () => {
    const root = await makeWorkspace();
    const map = await buildApplicationMap(root);
    const rendered = renderMapForModel(map);
    expect(rendered).toContain("src/api/reset.ts");
    expect(rendered).not.toContain("BEGIN PRIVATE KEY");
    expect(rendered).not.toContain("super-secret");

    const summary = toApplicationMapSummary(map, "orc-1");
    expect(summary).toMatchObject({ orchestrationId: "orc-1", version: 1 });
    expect(summary.fileCount).toBe(map.files.length);
  });
});
