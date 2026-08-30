import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTaskWorkspace,
  createTaskWorkspace,
  diffWorkspace,
  isPathWithinAllowed,
} from "./worker-workspaces.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

describe("createTaskWorkspace / diffWorkspace", () => {
  it("creates an isolated real copy and reports no changes before anything is edited", async () => {
    const source = await tempRoot("worker-ws-source-");
    await writeFile(path.join(source, "a.ts"), "export const a = 1;\n");
    const scratchRoot = await tempRoot("worker-ws-scratch-");

    const workspace = await createTaskWorkspace(scratchRoot, "orch-1", "task-1", source);
    expect(workspace.path).not.toBe(source);
    const copied = await readFile(path.join(workspace.path, "a.ts"), "utf8");
    expect(copied).toBe("export const a = 1;\n");

    expect(await diffWorkspace(workspace)).toEqual([]);
  });

  it("detects a real edit, a new file, and a deletion independently, without touching the source", async () => {
    const source = await tempRoot("worker-ws-source-");
    await writeFile(path.join(source, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(source, "b.ts"), "export const b = 1;\n");
    const scratchRoot = await tempRoot("worker-ws-scratch-");
    const workspace = await createTaskWorkspace(scratchRoot, "orch-1", "task-1", source);

    await writeFile(path.join(workspace.path, "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(workspace.path, "c.ts"), "export const c = 1;\n");
    await rm(path.join(workspace.path, "b.ts"));

    const changed = await diffWorkspace(workspace);
    expect(changed).toEqual(["a.ts", "b.ts", "c.ts"]);

    // the original source workspace is untouched
    expect(await readFile(path.join(source, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await readFile(path.join(source, "b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  it("isolates two concurrent task workspaces for the same source from each other", async () => {
    const source = await tempRoot("worker-ws-source-");
    await writeFile(path.join(source, "a.ts"), "export const a = 1;\n");
    const scratchRoot = await tempRoot("worker-ws-scratch-");

    const [workspaceA, workspaceB] = await Promise.all([
      createTaskWorkspace(scratchRoot, "orch-1", "task-a", source),
      createTaskWorkspace(scratchRoot, "orch-1", "task-b", source),
    ]);
    await writeFile(path.join(workspaceA.path, "a.ts"), "export const a = 100;\n");
    await writeFile(path.join(workspaceB.path, "a.ts"), "export const a = 200;\n");

    expect(await readFile(path.join(workspaceA.path, "a.ts"), "utf8")).toBe("export const a = 100;\n");
    expect(await readFile(path.join(workspaceB.path, "a.ts"), "utf8")).toBe("export const a = 200;\n");
  });
});

describe("isPathWithinAllowed", () => {
  it("allows an exact match and a nested path under an allowed directory", () => {
    expect(isPathWithinAllowed("src/auth/reset.ts", ["src/auth"])).toBe(true);
    expect(isPathWithinAllowed("src/auth", ["src/auth"])).toBe(true);
  });

  it("rejects a file outside every allowed path, and a same-prefix sibling directory", () => {
    expect(isPathWithinAllowed("src/billing/invoice.ts", ["src/auth"])).toBe(false);
    expect(isPathWithinAllowed("src/auth-legacy/old.ts", ["src/auth"])).toBe(false);
  });

  it("allows anything when no allowed paths are specified", () => {
    expect(isPathWithinAllowed("anything/at/all.ts", [])).toBe(true);
  });
});

describe("cleanupTaskWorkspace", () => {
  it("deletes a workspace that is genuinely inside the trusted scratch root", async () => {
    const source = await tempRoot("worker-ws-source-");
    await writeFile(path.join(source, "a.ts"), "x");
    const scratchRoot = await tempRoot("worker-ws-scratch-");
    const workspace = await createTaskWorkspace(scratchRoot, "orch-1", "task-1", source);

    await cleanupTaskWorkspace(workspace, scratchRoot);
    await expect(readFile(path.join(workspace.path, "a.ts"), "utf8")).rejects.toThrow();
  });

  it("refuses to clean up a path outside the trusted scratch root instead of silently no-op'ing", async () => {
    const scratchRoot = await tempRoot("worker-ws-scratch-");
    const outsideDir = await tempRoot("worker-ws-outside-");
    await mkdir(path.join(outsideDir, "definitely-not-scratch"), { recursive: true });
    const fakeWorkspace = { taskId: "task-1", path: outsideDir, baseManifest: [] };

    await expect(cleanupTaskWorkspace(fakeWorkspace, scratchRoot)).rejects.toThrow(/trusted scratch root/i);
    // proven not deleted
    await expect(readFile(path.join(outsideDir, "definitely-not-scratch"), "utf8")).rejects.toThrow(/EISDIR|ENOENT/);
  });
});
