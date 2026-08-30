import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMergePlan,
  applyResolvedConflict,
  collectConflictContext,
  detectMainWorkspaceDrift,
  planDeterministicMerge,
  publishToMainWorkspace,
  type TaskChangeSet,
} from "./integrator.js";
import { hashDirectory } from "./worker-workspaces.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "integrate-"));
  temporaryDirectories.push(root);
  return root;
}

async function makeTaskWorkspace(
  root: string,
  taskId: string,
  files: Record<string, string>,
  baseFiles: Record<string, string>,
): Promise<TaskChangeSet> {
  const directory = path.join(root, taskId);
  await mkdir(directory, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), content);
  }
  const manifest = await hashDirectory(directory);
  const baseManifest: Record<string, string> = {};
  for (const key of Object.keys(baseFiles)) {
    baseManifest[key] = "base-" + key;
  }
  const changed = Object.keys(files).filter((key) => key in baseManifest);
  const added = Object.keys(files).filter((key) => !(key in baseManifest));
  return {
    taskId,
    workspaceDirectory: directory,
    baseManifest,
    manifest,
    changed,
    added,
    removed: [],
  };
}

describe("deterministic-first integration", () => {
  it("merges non-overlapping worker changes with no conflicts and no model call", async () => {
    const root = await makeRoot();
    const persistence = await makeTaskWorkspace(
      root,
      "task-persistence",
      { "src/schema.ts": "schema v2\n" },
      { "src/schema.ts": "schema v1" },
    );
    const api = await makeTaskWorkspace(
      root,
      "task-api",
      { "src/api/reset.ts": "endpoint\n" },
      {},
    );

    const plan = planDeterministicMerge([persistence, api]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.operations.map((operation) => operation.path).sort()).toEqual([
      "src/api/reset.ts",
      "src/schema.ts",
    ]);

    const staging = path.join(root, "staging");
    await mkdir(staging, { recursive: true });
    const applied = await applyMergePlan(plan, [persistence, api], staging);
    expect(applied.skipped).toEqual([]);
    expect(await readFile(path.join(staging, "src", "schema.ts"), "utf8")).toBe("schema v2\n");
    expect(await readFile(path.join(staging, "src", "api", "reset.ts"), "utf8")).toBe(
      "endpoint\n",
    );
  });

  it("reports a conflict only when two tasks produce different content", async () => {
    const root = await makeRoot();
    const first = await makeTaskWorkspace(
      root,
      "task-a",
      { "src/shared.ts": "version A\n" },
      { "src/shared.ts": "base" },
    );
    const second = await makeTaskWorkspace(
      root,
      "task-b",
      { "src/shared.ts": "version B\n" },
      { "src/shared.ts": "base" },
    );
    const identical = await makeTaskWorkspace(
      root,
      "task-c",
      { "src/shared.ts": "version A\n" },
      { "src/shared.ts": "base" },
    );

    const conflicting = planDeterministicMerge([first, second]);
    expect(conflicting.conflicts).toEqual([
      { path: "src/shared.ts", taskIds: ["task-a", "task-b"] },
    ]);
    expect(conflicting.operations).toEqual([]);

    const agreeing = planDeterministicMerge([first, identical]);
    expect(agreeing.conflicts).toEqual([]);
    expect(agreeing.operations).toHaveLength(1);
  });

  it("gives the integrator only the conflicting files", async () => {
    const root = await makeRoot();
    const first = await makeTaskWorkspace(
      root,
      "task-a",
      { "src/shared.ts": "version A\n", "src/private-a.ts": "only mine\n" },
      { "src/shared.ts": "base" },
    );
    const second = await makeTaskWorkspace(
      root,
      "task-b",
      { "src/shared.ts": "version B\n" },
      { "src/shared.ts": "base" },
    );
    const plan = planDeterministicMerge([first, second]);
    const context = await collectConflictContext(plan.conflicts, [first, second]);

    expect(context).toHaveLength(1);
    expect(context[0]?.path).toBe("src/shared.ts");
    expect(context[0]?.versions.map((version) => version.content)).toEqual([
      "version A\n",
      "version B\n",
    ]);
    expect(JSON.stringify(context)).not.toContain("only mine");
  });

  it("applies a resolved conflict but refuses to escape the staging root", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    await mkdir(staging, { recursive: true });

    expect(await applyResolvedConflict(staging, "src/shared.ts", "merged\n")).toBe(true);
    expect(await readFile(path.join(staging, "src", "shared.ts"), "utf8")).toBe("merged\n");
    expect(await applyResolvedConflict(staging, "../escape.ts", "nope\n")).toBe(false);
  });
});

describe("publication", () => {
  it("detects user drift on a path the orchestration would publish", async () => {
    const root = await makeRoot();
    const main = path.join(root, "main");
    await mkdir(path.join(main, "src"), { recursive: true });
    await writeFile(path.join(main, "src", "shared.ts"), "original\n");
    await writeFile(path.join(main, "src", "other.ts"), "other\n");
    const base = await hashDirectory(main);

    const clean = await detectMainWorkspaceDrift(main, base, ["src/shared.ts"]);
    expect(clean).toEqual({ drifted: false, conflictingPaths: [] });

    await writeFile(path.join(main, "src", "shared.ts"), "the user edited this\n");
    const drifted = await detectMainWorkspaceDrift(main, base, ["src/shared.ts"]);
    expect(drifted).toEqual({ drifted: true, conflictingPaths: ["src/shared.ts"] });

    const unrelated = await detectMainWorkspaceDrift(main, base, ["src/other.ts"]);
    expect(unrelated.drifted).toBe(false);
  });

  it("publishes staged files into the main workspace", async () => {
    const root = await makeRoot();
    const main = path.join(root, "main");
    const staging = path.join(root, "staging");
    await mkdir(path.join(main, "src"), { recursive: true });
    await mkdir(path.join(staging, "src"), { recursive: true });
    await writeFile(path.join(main, "src", "a.ts"), "old\n");
    await writeFile(path.join(staging, "src", "a.ts"), "new\n");
    await writeFile(path.join(staging, "src", "b.ts"), "added\n");

    const result = await publishToMainWorkspace({
      stagingDirectory: staging,
      mainWorkspacePath: main,
      paths: ["src/a.ts", "src/b.ts"],
    });
    expect(result).toMatchObject({ rolledBack: false, error: null });
    expect(await readFile(path.join(main, "src", "a.ts"), "utf8")).toBe("new\n");
    expect(await readFile(path.join(main, "src", "b.ts"), "utf8")).toBe("added\n");
  });

  it("rolls back and leaves the main workspace unchanged when a path escapes", async () => {
    const root = await makeRoot();
    const main = path.join(root, "main");
    const staging = path.join(root, "staging");
    await mkdir(path.join(main, "src"), { recursive: true });
    await mkdir(path.join(staging, "src"), { recursive: true });
    await writeFile(path.join(main, "src", "a.ts"), "old\n");
    await writeFile(path.join(staging, "src", "a.ts"), "new\n");

    const result = await publishToMainWorkspace({
      stagingDirectory: staging,
      mainWorkspacePath: main,
      paths: ["src/a.ts", "../../escape.ts"],
    });
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("Refusing to publish outside");
    expect(await readFile(path.join(main, "src", "a.ts"), "utf8")).toBe("old\n");
  });
});
