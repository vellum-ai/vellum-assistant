/**
 * The recursive workspace walk: what it enters, what it lists without
 * entering, the order it reports, and the bounds that stop it.
 */
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import { walkWorkspaceTree } from "./workspace-tree-walk.js";

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const root = join(workspaceDir, "walk-fixture");

function write(relative: string, content = "x") {
  const abs = join(root, relative);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  write("b-dir/deep/leaf.md");
  write("b-dir/file-in-b.md");
  write("a-dir/file-in-a.md");
  write("top.md");
  write(".secret/inside-hidden.md");
  write("node_modules/dep/index.js");
  // Rules with an inner slash (data/db/) anchor to the workspace root, so
  // these live there rather than under the fixture directory.
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  writeFileSync(join(workspaceDir, "data", "db", "state.sqlite"), "x");
  mkdirSync(join(workspaceDir, "data", "avatar"), { recursive: true });
  writeFileSync(join(workspaceDir, "data", "avatar", "face.png"), "x");
  mkdirSync(join(workspaceDir, "walk-link-target"), { recursive: true });
  writeFileSync(join(workspaceDir, "walk-link-target", "behind.md"), "x");
  try {
    symlinkSync(
      join(workspaceDir, "walk-link-target"),
      join(root, "linked"),
      "dir",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  }
});

function walk(
  overrides: Partial<Parameters<typeof walkWorkspaceTree>[0]> = {},
) {
  return walkWorkspaceTree({
    rootPath: root,
    workspaceDir,
    showHidden: false,
    recursive: true,
    ...overrides,
  });
}

describe("walkWorkspaceTree recursive", () => {
  test("a non-recursive walk lists one level and reports nothing skipped", async () => {
    const result = await walk({ recursive: false });
    expect(result.entries.map((e) => e.path)).not.toContain(
      "walk-fixture/a-dir/file-in-a.md",
    );
    expect(result.entries.map((e) => e.name)).toContain("a-dir");
    expect(result).toMatchObject({ truncated: false, skipped: [] });
  });

  test("lists every level, depth-first, each directory in listing order", async () => {
    const { entries } = await walk();
    const paths = entries.map((e) => e.path.replace(/^walk-fixture\//, ""));
    const indexOf = (p: string) => paths.indexOf(p);
    expect(indexOf("a-dir/file-in-a.md")).toBeGreaterThan(-1);
    expect(indexOf("b-dir/deep/leaf.md")).toBeGreaterThan(-1);
    // Root listing first (directories before files), then a-dir's contents
    // before b-dir's, and b-dir's subdirectory before its file.
    expect(indexOf("a-dir")).toBeLessThan(indexOf("top.md"));
    expect(indexOf("top.md")).toBeLessThan(indexOf("a-dir/file-in-a.md"));
    expect(indexOf("a-dir/file-in-a.md")).toBeLessThan(indexOf("b-dir/deep"));
    expect(indexOf("b-dir/deep")).toBeLessThan(indexOf("b-dir/file-in-b.md"));
    expect(indexOf("b-dir/file-in-b.md")).toBeLessThan(
      indexOf("b-dir/deep/leaf.md"),
    );
  });

  test("grouping by parent recovers each directory's own listing", async () => {
    const { entries } = await walk();
    const shallow = await walkWorkspaceTree({
      rootPath: join(root, "b-dir"),
      workspaceDir,
      showHidden: false,
      recursive: false,
    });
    const underB = entries.filter(
      (e) =>
        e.path.startsWith("walk-fixture/b-dir/") &&
        !e.path.slice("walk-fixture/b-dir/".length).includes("/"),
    );
    expect(underB.map((e) => e.path)).toEqual(
      shallow.entries.map((e) => e.path),
    );
  });

  test("paths use forward slashes", async () => {
    const { entries } = await walk();
    expect(entries.every((e) => !e.path.includes("\\"))).toBe(true);
    expect(entries.map((e) => e.path)).toContain(
      "walk-fixture/b-dir/deep/leaf.md",
    );
  });

  test("hidden directories are neither listed nor entered unless asked", async () => {
    const hidden = (await walk()).entries.map((e) => e.path);
    expect(hidden).not.toContain("walk-fixture/.secret");
    expect(hidden).not.toContain("walk-fixture/.secret/inside-hidden.md");
    const shown = (await walk({ showHidden: true })).entries.map((e) => e.path);
    expect(shown).toContain("walk-fixture/.secret/inside-hidden.md");
  });

  test("a dependency directory is listed at any depth but not entered", async () => {
    const { entries, skipped } = await walk();
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("walk-fixture/node_modules");
    expect(paths).not.toContain("walk-fixture/node_modules/dep");
    expect(skipped).toContain("walk-fixture/node_modules");
  });

  test("root-anchored runtime state is listed, not entered, and named", async () => {
    const { entries, skipped } = await walk({ rootPath: workspaceDir });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("data/db");
    expect(paths).not.toContain("data/db/state.sqlite");
    // A directory the rules do not exclude is entered, and a file the rules
    // match (*.png) is still listed: only descent is decided by them.
    expect(paths).toContain("data/avatar/face.png");
    expect(skipped).toContain("data/db");
    expect(skipped).not.toContain("data/avatar");
  });

  test("a symlinked directory is listed, not entered, and reported skipped", async () => {
    const { entries, skipped } = await walk();
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("walk-fixture/linked");
    expect(paths).not.toContain("walk-fixture/linked/behind.md");
    expect(skipped).toContain("walk-fixture/linked");
  });

  test("an unreadable directory is listed, not entered, and reported skipped", async () => {
    // Root bypasses permission bits, so the check proves nothing there.
    if (process.getuid?.() === 0) {
      return;
    }
    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "inside.md"), "x");
    chmodSync(locked, 0o000);
    try {
      const { entries, skipped, truncated } = await walk();
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("walk-fixture/locked");
      expect(paths).not.toContain("walk-fixture/locked/inside.md");
      expect(skipped).toContain("walk-fixture/locked");
      expect(truncated).toBe(false);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  test("a directory wider than the remaining room is not scanned", async () => {
    // Root (5) leaves one slot at a cap of 6; a-dir (1) fits and b-dir (2)
    // does not. Nothing under b-dir is stat'd: its walk-time stat would
    // otherwise show up as a listed entry.
    const wide = join(root, "wide");
    mkdirSync(wide, { recursive: true });
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(wide, `w${i}.md`), "x");
    }
    try {
      const result = await walk({ maxEntries: 7 });
      const paths = result.entries.map((e) => e.path);
      expect(paths).toContain("walk-fixture/wide");
      expect(paths.some((p) => p.startsWith("walk-fixture/wide/"))).toBe(false);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  });

  test("the deadline is honored inside a directory, not only between them", async () => {
    // A clock that advances one second per read: the deadline is set at 0,
    // the check before the first nested directory reads 1000 and passes,
    // and the first entry inside it reads 2000 and stops the listing. Were
    // the deadline checked only between directories, that one-entry
    // directory would be carried and the walk would stop one step later.
    let reads = 0;
    const result = await walk({ maxWalkMs: 1500, now: () => reads++ * 1000 });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBe(5);
  });

  test("the entry cap stops descent and reports truncated", async () => {
    // The fixture root lists five entries and holds nine in all.
    const result = await walk({ maxEntries: 6 });
    expect(result.entries.length).toBeLessThanOrEqual(6);
    expect(result.entries.length).toBeGreaterThanOrEqual(5);
    expect(result.truncated).toBe(true);
  });

  test("a directory is carried whole or not at all", async () => {
    // Root (5) plus a-dir (1) fit in 6; b-dir's two entries do not, so
    // neither of them appears rather than one of them.
    const { entries } = await walk({ maxEntries: 6 });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("walk-fixture/a-dir/file-in-a.md");
    expect(paths).not.toContain("walk-fixture/b-dir/deep");
    expect(paths).not.toContain("walk-fixture/b-dir/file-in-b.md");
  });

  test("the root listing is whole even under a cap smaller than it", async () => {
    const result = await walk({ maxEntries: 1 });
    expect(result.entries.map((e) => e.name)).toContain("top.md");
    expect(result.truncated).toBe(true);
  });

  test("the deadline stops the walk and reports truncated", async () => {
    const result = await walk({ maxWalkMs: -1 });
    expect(result.truncated).toBe(true);
  });

  test("directory sizes are null in a recursive walk even when a sizer is given", async () => {
    const { entries } = await walk({ directorySize: () => 42 });
    const dir = entries.find((e) => e.type === "directory");
    expect(dir?.size).toBeNull();
  });
});
