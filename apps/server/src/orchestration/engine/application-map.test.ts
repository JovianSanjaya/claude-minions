import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplicationMap } from "./application-map.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "application-map-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("buildApplicationMap", () => {
  it("scans real files deterministically and extracts imports/exports from source files", async () => {
    const root = await tempWorkspace();
    await mkdir(path.join(root, "src", "auth"), { recursive: true });
    await writeFile(
      path.join(root, "src", "auth", "reset.ts"),
      `import { sendEmail } from "../email.js";\nexport function requestReset(userId: string) {}\n`,
    );
    await writeFile(path.join(root, "src", "email.ts"), `export function sendEmail() {}\n`);
    await writeFile(path.join(root, "README.md"), "# hello\n");

    const map = await buildApplicationMap("orch-1", root, 1);
    expect(map.summary.fileCount).toBe(3);
    expect(map.directories).toContain("src");
    expect(map.directories).toContain(path.join("src", "auth"));

    const resetFile = map.files.find((file) => file.path.endsWith("reset.ts"));
    expect(resetFile?.imports).toContain("../email.js");
    expect(resetFile?.exports).toContain("requestReset");
  });

  it("excludes node_modules, .git, dist, and .env-style files", async () => {
    const root = await tempWorkspace();
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;");
    await writeFile(path.join(root, ".git", "config"), "junk");
    await writeFile(path.join(root, "dist", "bundle.js"), "junk");
    await writeFile(path.join(root, ".env"), "SECRET=abc123");
    await writeFile(path.join(root, "index.ts"), "export const ok = true;\n");

    const map = await buildApplicationMap("orch-1", root, 1);
    expect(map.summary.fileCount).toBe(1);
    expect(map.files[0]?.path).toBe("index.ts");
  });

  it("produces a stable repository hash for identical content and a different one after a real change", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const first = await buildApplicationMap("orch-1", root, 1);
    const second = await buildApplicationMap("orch-1", root, 1);
    expect(first.summary.repositoryHash).toBe(second.summary.repositoryHash);

    await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
    const third = await buildApplicationMap("orch-1", root, 1);
    expect(third.summary.repositoryHash).not.toBe(first.summary.repositoryHash);
  });

  it("versions the summary with the version passed in", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const map = await buildApplicationMap("orch-1", root, 3);
    expect(map.summary.version).toBe(3);
    expect(map.summary.orchestrationId).toBe("orch-1");
  });
});
