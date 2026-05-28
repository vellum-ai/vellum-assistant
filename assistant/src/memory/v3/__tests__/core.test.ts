import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadCore } from "../core.js";

const BUNDLED_DATA_DIR = join(import.meta.dir, "..", "data");

describe("loadCore", () => {
  const originalWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  let tmpDirs: string[] = [];

  beforeEach(() => {
    delete process.env.VELLUM_WORKSPACE_DIR;
    tmpDirs = [];
  });

  afterEach(async () => {
    if (originalWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceEnv;
    }
    await Promise.all(
      tmpDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "v3-core-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("loads alwaysOn from bundled core.json into a Set", async () => {
    // No workspace override → resolves to the supplied bundled dataDir.
    process.env.VELLUM_WORKSPACE_DIR = await makeTmpDir();
    const core = await loadCore(BUNDLED_DATA_DIR);
    expect(core).toBeInstanceOf(Set);
    expect(core.has("domain-a/topic-x")).toBe(true);
    expect(core.size).toBe(1);
  });

  test("prefers workspace override when present", async () => {
    const workspace = await makeTmpDir();
    const overrideDataDir = join(workspace, "memory", "v3", "data");
    await mkdir(overrideDataDir, { recursive: true });
    await writeFile(
      join(overrideDataDir, "core.json"),
      JSON.stringify({ alwaysOn: ["domain-z/topic-override"] }),
    );
    process.env.VELLUM_WORKSPACE_DIR = workspace;

    const core = await loadCore(BUNDLED_DATA_DIR);
    expect(core.has("domain-z/topic-override")).toBe(true);
    expect(core.has("domain-a/topic-x")).toBe(false);
    expect(core.size).toBe(1);
  });

  test("returns empty set when core.json is missing", async () => {
    // Point the workspace at a dir with no override so resolution is
    // deterministic and falls back to the (empty) supplied dataDir.
    process.env.VELLUM_WORKSPACE_DIR = await makeTmpDir();
    const emptyDataDir = await makeTmpDir();
    const core = await loadCore(emptyDataDir);
    expect(core).toBeInstanceOf(Set);
    expect(core.size).toBe(0);
  });
});
