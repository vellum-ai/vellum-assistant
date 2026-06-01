import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { loadCore } from "../core.js";

const BUNDLED_DATA_DIR = join(import.meta.dir, "..", "data");

describe("loadCore", () => {
  let tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tmpDirs = [];
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "v3-core-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("loads alwaysOn from the supplied dataDir's core.json into a Set", async () => {
    const core = await loadCore(BUNDLED_DATA_DIR);
    expect(core).toBeInstanceOf(Set);
    expect(core.has("domain-a/topic-x")).toBe(true);
    expect(core.size).toBe(1);
  });

  test("returns empty set when core.json is missing", async () => {
    const emptyDataDir = await makeTmpDir();
    const core = await loadCore(emptyDataDir);
    expect(core).toBeInstanceOf(Set);
    expect(core.size).toBe(0);
  });
});
