import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestrationTask } from "../contracts.js";
import { ApplicationMapBuilder } from "./application-map.js";
import { WorkerWorkspaceManager } from "./worker-workspaces.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isolated worker workspaces", () => {
  it("materializes only allocated context, detects scope violations and main-workspace drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "engine-workspace-"));
    roots.push(root);
    const main = path.join(root, "main");
    await mkdir(path.join(main, "server"), { recursive: true });
    await mkdir(path.join(main, "web"), { recursive: true });
    await writeFile(path.join(main, "server", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(main, "web", "b.ts"), "export const b = 1;\n");
    const map = await new ApplicationMapBuilder().build("orch", main);
    const manager = new WorkerWorkspaceManager(path.join(root, "temp"), path.join(root, "archive"));
    const task = {
      id: "task",
      orchestrationId: "orch",
      allowedPaths: ["server"],
    } as OrchestrationTask;
    const worker = await manager.create("orch", task, map, ["server/a.ts"]);
    await expect(readFile(path.join(worker.workspacePath, "web", "b.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(worker.workspacePath, "server", "a.ts"), "export const a = 2;\n");
    await mkdir(path.join(worker.workspacePath, "web"), { recursive: true });
    await writeFile(path.join(worker.workspacePath, "web", "bad.ts"), "bad\n");
    const manifest = await manager.inspect(worker);
    expect(manifest.scopeViolations).toEqual(["web/bad.ts"]);
    await writeFile(path.join(main, "server", "a.ts"), "export const a = 99;\n");
    expect(await manager.mainWorkspaceDrift(worker, ["server/a.ts"])).toEqual(["server/a.ts"]);
    await expect(manager.cleanup(worker, "clean")).resolves.toMatchObject({ disposition: "cleaned" });
  });
});
