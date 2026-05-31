import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { restoreDataDir, snapshotDataDir } from "../snapshot.js";

let tmpRoot: string;
let dataDir: string;

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function listLeaves(dir: string): Promise<Record<string, string>> {
  const leavesDir = path.join(dir, "leaves");
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out[rel] = await fs.readFile(abs, "utf8");
      }
    }
  }
  await walk(leavesDir, "");
  return out;
}

async function seedDataDir(): Promise<void> {
  await fs.mkdir(path.join(dataDir, "leaves", "alpha"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "leaves", "alpha", "leaf-1.md"),
    "leaf one body",
  );
  await fs.writeFile(
    path.join(dataDir, "leaves", "leaf-2.md"),
    "leaf two body",
  );
  await fs.writeFile(
    path.join(dataDir, "assignments.json"),
    JSON.stringify({ "leaf-1": ["topic-a"] }),
  );
  await fs.writeFile(
    path.join(dataDir, "core.json"),
    JSON.stringify({ version: 1, root: "topic-a" }),
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "v3-snapshot-"));
  dataDir = path.join(tmpRoot, "data");
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("snapshotDataDir / restoreDataDir", () => {
  test("roundtrips leaves, assignments, and core", async () => {
    await seedDataDir();
    const before = {
      leaves: await listLeaves(dataDir),
      assignments: await readJson(path.join(dataDir, "assignments.json")),
      core: await readJson(path.join(dataDir, "core.json")),
    };

    const snapshotPath = await snapshotDataDir(dataDir, { label: "snap-1" });

    // Mutate the live data dir after snapshotting.
    await fs.writeFile(
      path.join(dataDir, "leaves", "alpha", "leaf-1.md"),
      "CORRUPTED",
    );
    await fs.rm(path.join(dataDir, "leaves", "leaf-2.md"));
    await fs.writeFile(
      path.join(dataDir, "assignments.json"),
      JSON.stringify({ broken: true }),
    );
    await fs.writeFile(
      path.join(dataDir, "core.json"),
      JSON.stringify({ broken: true }),
    );

    await restoreDataDir(snapshotPath, dataDir);

    expect(await listLeaves(dataDir)).toEqual(before.leaves);
    expect(await readJson(path.join(dataDir, "assignments.json"))).toEqual(
      before.assignments,
    );
    expect(await readJson(path.join(dataDir, "core.json"))).toEqual(
      before.core,
    );
  });

  test("roundtrips the pageRefs diff", async () => {
    await seedDataDir();
    const pageRefs = new Map<string, string[]>([
      ["slug-one", ["leaf-1", "leaf-2"]],
      ["slug-two", ["leaf-3"]],
    ]);

    const snapshotPath = await snapshotDataDir(dataDir, {
      label: "snap-refs",
      pageRefs,
    });

    const { pageRefs: restored } = await restoreDataDir(snapshotPath, dataDir);
    expect(restored).toBeDefined();
    expect(restored).toEqual(pageRefs);
  });

  test("returns no pageRefs when none were captured", async () => {
    await seedDataDir();
    const snapshotPath = await snapshotDataDir(dataDir, { label: "snap-none" });
    const result = await restoreDataDir(snapshotPath, dataDir);
    expect(result.pageRefs).toBeUndefined();
  });

  test("restoring removes leaves added after the snapshot", async () => {
    await seedDataDir();
    const snapshotPath = await snapshotDataDir(dataDir, { label: "snap-add" });

    await fs.writeFile(
      path.join(dataDir, "leaves", "leaf-extra.md"),
      "added later",
    );

    await restoreDataDir(snapshotPath, dataDir);
    const leaves = await listLeaves(dataDir);
    expect(leaves["leaf-extra.md"]).toBeUndefined();
    expect(leaves["leaf-2.md"]).toBe("leaf two body");
  });

  test("retention is bounded to the last N snapshots", async () => {
    await seedDataDir();
    // Zero-padded labels sort chronologically.
    const labels = Array.from(
      { length: 8 },
      (_, i) => `snap-${String(i).padStart(2, "0")}`,
    );
    for (const label of labels) {
      await snapshotDataDir(dataDir, { label });
    }

    const snapshotsRoot = path.join(tmpRoot, "v3-snapshots");
    const remaining = (await fs.readdir(snapshotsRoot)).sort();
    expect(remaining.length).toBe(5);
    // Oldest three pruned, newest five kept.
    expect(remaining).toEqual([
      "snap-03",
      "snap-04",
      "snap-05",
      "snap-06",
      "snap-07",
    ]);
  });
});
