/**
 * Tests for the plugin content-fingerprint helpers.
 *
 * Each test materializes a real tree under a temp directory, fingerprints it,
 * then mutates the tree and asserts the comparison reports the expected
 * modified / added / removed paths. The sidecar is exercised through the
 * `exclude` argument so it never counts as a local addition.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  comparePluginFingerprint,
  computePluginFingerprint,
  parsePluginFingerprint,
} from "../plugin-fingerprint.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-fingerprint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

describe("computePluginFingerprint", () => {
  test("digests every regular file with POSIX-relative keys", () => {
    // GIVEN a tree with a nested file
    write("package.json", "{}");
    write("src/index.ts", "export const x = 1;");

    // WHEN it is fingerprinted
    const fp = computePluginFingerprint(root);

    // THEN every file is keyed by its forward-slash relative path
    expect(Object.keys(fp.files).sort()).toEqual([
      "package.json",
      "src/index.ts",
    ]);
    expect(fp.algorithm).toBe("sha256");
    expect(fp.files["src/index.ts"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("excludes named top-level entries (the sidecar)", () => {
    // GIVEN a tree containing the provenance sidecar
    write("package.json", "{}");
    write(".vellum-plugin.json", '{"name":"x"}');

    // WHEN it is fingerprinted excluding the sidecar
    const fp = computePluginFingerprint(root, [".vellum-plugin.json"]);

    // THEN the sidecar is not part of the digest map
    expect(Object.keys(fp.files)).toEqual(["package.json"]);
  });

  test("skips symlinks", () => {
    // GIVEN a tree with a real file and a symlink to it
    write("real.txt", "hello");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));

    // WHEN it is fingerprinted
    const fp = computePluginFingerprint(root);

    // THEN only the regular file is digested
    expect(Object.keys(fp.files)).toEqual(["real.txt"]);
  });
});

describe("comparePluginFingerprint", () => {
  test("reports clean when the tree is unchanged", () => {
    // GIVEN a fingerprinted tree
    write("a.txt", "one");
    write("b.txt", "two");
    const baseline = computePluginFingerprint(root);

    // WHEN it is compared against itself untouched
    const diff = comparePluginFingerprint(root, baseline);

    // THEN nothing is reported as changed
    expect(diff.clean).toBe(true);
    expect(diff.modified).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("classifies modified, added, and removed files", () => {
    // GIVEN a baseline of two files
    write("keep.txt", "keep");
    write("change.txt", "before");
    const baseline = computePluginFingerprint(root);

    // AND the tree is edited: one file changed, one added, one removed
    write("change.txt", "after");
    write("new.txt", "fresh");
    rmSync(join(root, "keep.txt"));

    // WHEN the tree is compared against the baseline
    const diff = comparePluginFingerprint(root, baseline);

    // THEN each change is bucketed correctly
    expect(diff.clean).toBe(false);
    expect(diff.modified).toEqual(["change.txt"]);
    expect(diff.added).toEqual(["new.txt"]);
    expect(diff.removed).toEqual(["keep.txt"]);
  });

  test("does not count an excluded sidecar as an addition", () => {
    // GIVEN a baseline computed with the sidecar excluded
    write("package.json", "{}");
    const baseline = computePluginFingerprint(root, [".vellum-plugin.json"]);

    // AND the sidecar exists on disk (as it would post-install)
    write(".vellum-plugin.json", '{"name":"x"}');

    // WHEN compared with the same exclusion
    const diff = comparePluginFingerprint(root, baseline, [
      ".vellum-plugin.json",
    ]);

    // THEN the tree is still clean
    expect(diff.clean).toBe(true);
  });
});

describe("parsePluginFingerprint", () => {
  test("round-trips a computed fingerprint through JSON", () => {
    // GIVEN a computed fingerprint serialized to JSON
    write("a.txt", "one");
    const fp = computePluginFingerprint(root);

    // WHEN it is parsed back
    const parsed = parsePluginFingerprint(JSON.parse(JSON.stringify(fp)));

    // THEN it matches the original
    expect(parsed).toEqual(fp);
  });

  test.each([
    ["a non-object", 42],
    ["a wrong algorithm", { algorithm: "md5", files: {} }],
    ["a missing files map", { algorithm: "sha256" }],
    ["a non-string digest", { algorithm: "sha256", files: { a: 1 } }],
  ])("returns null for %s", (_label, value) => {
    // WHEN a malformed value is parsed
    const parsed = parsePluginFingerprint(value);

    // THEN it is rejected leniently
    expect(parsed).toBeNull();
  });
});
