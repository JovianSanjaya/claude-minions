import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionContract,
  OrchestrationSink,
  OrchestrationTask,
} from "../contracts.js";
import { ApplicationMapBuilder } from "./application-map.js";
import { ContextBroker } from "./context-broker.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sink = {
  recordContextPacket: async () => undefined,
  recordEvent: async () => undefined,
} as unknown as OrchestrationSink;

describe("application map and context broker", () => {
  it("maps deterministic facts while excluding secrets, dependencies and symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "engine-map-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "src", "types.ts"), "export interface Item { id: string }\n");
    await writeFile(path.join(root, "src", "main.ts"), 'import type { Item } from "./types.js";\nexport const item: Item = { id: "1" };\n');
    await writeFile(path.join(root, ".env"), "EXAMPLE_SETTING=value\n");
    await writeFile(path.join(root, "node_modules", "x", "index.js"), "secret");
    await symlink("/etc/hosts", path.join(root, "src", "escape.ts"));

    const map = await new ApplicationMapBuilder().build("orch", root, { version: 3 });
    expect(map.summary.version).toBe(3);
    expect(map.files.map((file) => file.path)).toEqual(["src/main.ts", "src/types.ts"]);
    expect(map.files.find((file) => file.path === "src/main.ts")?.imports).toContain("./types.js");
    expect(map.summary.repositoryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a minimum packet and denies traversal, symlink and expansion over-budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "engine-context-"));
    roots.push(root);
    await mkdir(path.join(root, "server"), { recursive: true });
    await mkdir(path.join(root, "web"), { recursive: true });
    await writeFile(path.join(root, "server", "api.ts"), "export const api = 1;\n");
    await writeFile(path.join(root, "web", "page.ts"), "export const page = 1;\n");
    await symlink("/etc/hosts", path.join(root, "server", "escape.ts"));
    const map = await new ApplicationMapBuilder().build("orch", root);
    const task: OrchestrationTask = {
      id: "task",
      orchestrationId: "orch",
      title: "API",
      objective: "Change API",
      status: "ready",
      dependsOn: [],
      allowedPaths: ["server/api.ts"],
      acceptanceCriterionIds: ["c1"],
      requiredArtifactIds: [],
      observedArtifactVersions: {},
      applicationMapVersion: 1,
      attemptCount: 0,
    };
    const contract = {
      version: 1,
      criteria: [{ id: "c1", kind: "functional", description: "works", verification: "visible-test" }],
    } as ExecutionContract;
    const broker = new ContextBroker();
    const packet = await broker.createPacket({ map, task, contract, artifacts: [], sink });
    expect(packet.sources.map((source) => source.path)).toEqual(["server/api.ts"]);
    await expect(
      broker.requestExpansion({
        orchestrationId: "orch",
        task,
        map,
        requestedPath: "../outside",
        reason: "need it",
        maxExpansions: 1,
        sink,
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      broker.requestExpansion({
        orchestrationId: "orch",
        task,
        map,
        requestedPath: "server/escape.ts",
        reason: "need it",
        maxExpansions: 1,
        sink,
      }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      broker.requestExpansion({
        orchestrationId: "orch",
        task,
        map,
        requestedPath: "web/page.ts",
        reason: "interface",
        maxExpansions: 0,
        sink,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining("budget") });
  });
});
