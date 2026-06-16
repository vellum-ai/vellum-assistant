/**
 * Tests for {@link mergePluginTree}.
 *
 * The merge is exercised against three real temp directories (base/ours/theirs)
 * and the merged tree is read back from a fourth (dest). `git merge-file` runs
 * for real — these tests assert the line-level merge behavior (non-conflicting
 * hunks from both sides survive; conflicts resolve toward the strategy), the
 * file-level add/delete resolution, and binary whole-file handling.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mergePluginTree } from "../merge-plugin-tree.js";

/** A file tree keyed by POSIX-relative path; Buffer values are binary files. */
type Tree = Record<string, string | Buffer>;

let scratch: string;
let baseDir: string;
let oursDir: string;
let theirsDir: string;
let destDir: string;

function writeTree(root: string, tree: Tree): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Read a merged file as UTF-8, or null when absent from the dest tree. */
function read(rel: string): string | null {
  const abs = join(destDir, rel);
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "merge-plugin-tree-"));
  baseDir = join(scratch, "base");
  oursDir = join(scratch, "ours");
  theirsDir = join(scratch, "theirs");
  destDir = join(scratch, "dest");
  for (const d of [baseDir, oursDir, theirsDir, destDir]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("mergePluginTree", () => {
  test("keeps non-conflicting edits from both sides and resolves conflicts toward ours", async () => {
    // GIVEN a file edited on disjoint lines by each side, a true conflict, and
    // a one-sided addition on each side
    writeTree(baseDir, {
      "common.txt": "a\nb\nc\n",
      "conflict.txt": "base\n",
    });
    writeTree(oursDir, {
      "common.txt": "A\nb\nc\n",
      "conflict.txt": "ours\n",
      "local-only.txt": "local\n",
    });
    writeTree(theirsDir, {
      "common.txt": "a\nb\nC\n",
      "conflict.txt": "theirs\n",
      "remote-only.txt": "remote\n",
    });

    // WHEN merged with the `ours` strategy
    const count = await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "ours",
    });

    // THEN both disjoint edits survive, both additions land, and the conflict
    // resolves toward the local edit
    expect(read("common.txt")).toBe("A\nb\nC\n");
    expect(read("local-only.txt")).toBe("local\n");
    expect(read("remote-only.txt")).toBe("remote\n");
    expect(read("conflict.txt")).toBe("ours\n");
    expect(count).toBe(4);
  });

  test("resolves conflicts toward the pin under the theirs strategy", async () => {
    // GIVEN a file edited differently on both sides
    writeTree(baseDir, { "conflict.txt": "base\n" });
    writeTree(oursDir, { "conflict.txt": "ours\n" });
    writeTree(theirsDir, { "conflict.txt": "theirs\n" });

    // WHEN merged with the `theirs` strategy
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "theirs",
    });

    // THEN the conflicting hunk resolves toward the pin
    expect(read("conflict.txt")).toBe("theirs\n");
  });

  test("never writes conflict markers", async () => {
    // GIVEN a hard conflict on every line
    writeTree(baseDir, { "f.txt": "1\n2\n3\n" });
    writeTree(oursDir, { "f.txt": "1\nOURS\n3\n" });
    writeTree(theirsDir, { "f.txt": "1\nTHEIRS\n3\n" });

    // WHEN merged
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "ours",
    });

    // THEN the result carries no git conflict markers
    const merged = read("f.txt") ?? "";
    expect(merged).not.toContain("<<<<<<<");
    expect(merged).not.toContain("=======");
    expect(merged).not.toContain(">>>>>>>");
  });

  test("drops a file deleted upstream when it is unchanged locally", async () => {
    // GIVEN a file present at base and locally but removed at the pin
    writeTree(baseDir, { "gone.txt": "keep\n", "stay.txt": "x\n" });
    writeTree(oursDir, { "gone.txt": "keep\n", "stay.txt": "x\n" });
    writeTree(theirsDir, { "stay.txt": "x\n" });

    // WHEN merged
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "theirs",
    });

    // THEN the upstream deletion is honored
    expect(read("gone.txt")).toBeNull();
    expect(read("stay.txt")).toBe("x\n");
  });

  test("keeps a locally-edited file the pin deleted under the ours strategy", async () => {
    // GIVEN a modify/delete conflict: edited locally, deleted at the pin
    writeTree(baseDir, { "f.txt": "base\n" });
    writeTree(oursDir, { "f.txt": "local edit\n" });
    writeTree(theirsDir, {});

    // WHEN merged with `ours`
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "ours",
    });

    // THEN the local edit wins over the deletion
    expect(read("f.txt")).toBe("local edit\n");
  });

  test("honors the pin's deletion of a locally-edited file under the theirs strategy", async () => {
    // GIVEN the same modify/delete conflict
    writeTree(baseDir, { "f.txt": "base\n" });
    writeTree(oursDir, { "f.txt": "local edit\n" });
    writeTree(theirsDir, {});

    // WHEN merged with `theirs`
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "theirs",
    });

    // THEN the deletion wins over the local edit
    expect(read("f.txt")).toBeNull();
  });

  test("resolves a binary conflict whole-file by strategy rather than line-merging", async () => {
    // GIVEN a binary file (NUL bytes) diverged on both sides
    const base = Buffer.from([0x00, 0x01, 0x02]);
    const ours = Buffer.from([0x00, 0xaa, 0xbb]);
    const theirs = Buffer.from([0x00, 0xcc, 0xdd]);
    writeTree(baseDir, { "img.bin": base });
    writeTree(oursDir, { "img.bin": ours });
    writeTree(theirsDir, { "img.bin": theirs });

    // WHEN merged with `theirs`
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "theirs",
    });

    // THEN the whole pin blob is taken, byte-for-byte (no markers, no corruption)
    expect(readFileSync(join(destDir, "img.bin")).equals(theirs)).toBe(true);
  });

  test("excludes the provenance sidecar from the merge", async () => {
    // GIVEN an install-meta sidecar present on every side with differing content
    writeTree(baseDir, {
      "install-meta.json": '{"commit":"base"}',
      "f.txt": "x\n",
    });
    writeTree(oursDir, {
      "install-meta.json": '{"commit":"ours"}',
      "f.txt": "x\n",
    });
    writeTree(theirsDir, {
      "install-meta.json": '{"commit":"theirs"}',
      "f.txt": "x\n",
    });

    // WHEN merged
    const count = await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "ours",
    });

    // THEN the sidecar is never carried through (the caller rewrites it)
    expect(read("install-meta.json")).toBeNull();
    expect(count).toBe(1);
  });

  test("merges files in nested directories", async () => {
    // GIVEN a conflict on a deeply-nested file
    writeTree(baseDir, { "src/a/b.txt": "base\n" });
    writeTree(oursDir, { "src/a/b.txt": "ours\n" });
    writeTree(theirsDir, { "src/a/b.txt": "theirs\n" });

    // WHEN merged
    await mergePluginTree({
      baseDir,
      oursDir,
      theirsDir,
      destDir,
      strategy: "ours",
    });

    // THEN the nested path is preserved and resolved
    expect(read("src/a/b.txt")).toBe("ours\n");
  });
});
