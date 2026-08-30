import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkerWorkspaceManager,
  detectScopeViolations,
  diffManifests,
  hashDirectory,
  manifestHash,
} from "./worker-workspaces.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoots(): Promise<{
  source: string;
  temp: string;
  archive: string;
  manager: WorkerWorkspaceManager;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "worker-ws-"));
  temporaryDirectories.push(root);
  const source = path.join(root, "workspace");
  const temp = path.join(root, "temp");
  const archive = path.join(root, "archive");
  await mkdir(path.join(source, "src", "api"), { recursive: true });
  await mkdir(path.join(source, "node_modules"), { recursive: true });
  await writeFile(path.join(source, "src", "api", "reset.ts"), "export const reset = 1;\n");
  await writeFile(path.join(source, "src", "schema.ts"), "export const schema = 1;\n");
  await writeFile(path.join(source, ".env"), "ARK_API_KEY=super-secret\n");
  await writeFile(path.join(source, "node_modules", "big.js"), "module.exports = 1;\n");
  return { source, temp, archive, manager: new WorkerWorkspaceManager(temp, archive) };
}

describe("isolated worker workspaces", () => {
  it("snapshots the source without dependencies or credential files", async () => {
    const { source, manager } = await makeRoots();
    const workspace = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/api/**"],
    });

    expect(Object.keys(workspace.baseManifest).sort()).toEqual([
      "src/api/reset.ts",
      "src/schema.ts",
    ]);
    expect(workspace.baseHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(readFile(path.join(workspace.directory, ".env"), "utf8")).rejects.toThrow();
  });

  it("keeps concurrent tasks in separate directories and leaves the source untouched", async () => {
    const { source, manager } = await makeRoots();
    const first = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/api/**"],
    });
    const second = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-web",
      executionId: "exec-2",
      sourcePath: source,
      allowedPaths: ["src/web/**"],
    });
    expect(first.directory).not.toBe(second.directory);

    await writeFile(path.join(first.directory, "src", "api", "reset.ts"), "changed\n");
    const sourceManifest = await hashDirectory(source);
    expect(sourceManifest["src/api/reset.ts"]).toBe(second.baseManifest["src/api/reset.ts"]);
  });

  it("attributes changed files and detects scope violations", async () => {
    const { source, manager } = await makeRoots();
    const workspace = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/api/**"],
    });
    await writeFile(
      path.join(workspace.directory, "src", "api", "reset.ts"),
      "export const reset = 2;\n",
    );
    await writeFile(path.join(workspace.directory, "src", "api", "token.ts"), "new\n");
    await writeFile(path.join(workspace.directory, "src", "schema.ts"), "tampered\n");

    const report = await manager.inspectChanges(workspace);
    expect(report.changed).toContain("src/api/reset.ts");
    expect(report.added).toEqual(["src/api/token.ts"]);
    expect(report.scopeViolations).toEqual(["src/schema.ts"]);
  });

  it("does not copy symlinks into a worker snapshot", async () => {
    const { source, manager } = await makeRoots();
    const outside = await mkdtemp(path.join(tmpdir(), "worker-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    await symlink(path.join(outside, "secret.ts"), path.join(source, "src", "escape.ts"));

    const workspace = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/**"],
    });
    expect(Object.keys(workspace.baseManifest)).not.toContain("src/escape.ts");
  });
});

describe("cleanup safety", () => {
  it("archives a task workspace under the archive root", async () => {
    const { source, manager, archive } = await makeRoots();
    const workspace = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/**"],
    });
    const result = await manager.cleanup(workspace.directory, "archive");
    expect(result.result).toBe("archived");
    expect(result.path.startsWith(path.resolve(archive))).toBe(true);
  });

  it("removes a task workspace when the policy is cleanup", async () => {
    const { source, manager } = await makeRoots();
    const workspace = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/**"],
    });
    const result = await manager.cleanup(workspace.directory, "cleanup");
    expect(result.result).toBe("cleaned");
    await expect(readFile(path.join(workspace.directory, "src", "schema.ts"))).rejects.toThrow();
  });

  it("refuses to clean anything that is not a task-specific temp directory", async () => {
    const { source, manager, temp } = await makeRoots();
    for (const target of [
      "/",
      path.resolve(temp),
      manager.orchestrationRoot("orc-1"),
      source,
    ]) {
      const result = await manager.cleanup(target, "cleanup");
      expect(result.result).toBe("refused");
      expect(result.reason).toContain("retained for manual review");
    }
    // The source workspace must still be intact after a refused cleanup.
    expect(await readFile(path.join(source, "src", "schema.ts"), "utf8")).toContain("schema");
  });

  it("retains a workspace when the policy is retain", async () => {
    const { source, manager } = await makeRoots();
    const workspace = await manager.createTaskWorkspace({
      orchestrationId: "orc-1",
      taskId: "task-api",
      executionId: "exec-1",
      sourcePath: source,
      allowedPaths: ["src/**"],
    });
    const result = await manager.cleanup(workspace.directory, "retain");
    expect(result.result).toBe("retained");
    expect(await readFile(path.join(workspace.directory, "src", "schema.ts"), "utf8")).toContain(
      "schema",
    );
  });
});

describe("manifest helpers", () => {
  it("diffs and hashes manifests deterministically", () => {
    const base = { "a.ts": "1", "b.ts": "2" };
    const next = { "a.ts": "1", "b.ts": "3", "c.ts": "4" };
    expect(diffManifests(base, next)).toEqual({
      changed: ["b.ts"],
      added: ["c.ts"],
      removed: [],
    });
    expect(manifestHash(base)).toBe(manifestHash({ "b.ts": "2", "a.ts": "1" }));
    expect(manifestHash(base)).not.toBe(manifestHash(next));
  });

  it("treats an empty allowed-path list as unrestricted", () => {
    expect(detectScopeViolations(["a.ts"], [])).toEqual([]);
    expect(detectScopeViolations(["a.ts"], ["b/**"])).toEqual(["a.ts"]);
  });
});
