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
  compareFingerprint,
  computeContentHash,
  computeFingerprint,
  parseFingerprint,
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

describe("computeFingerprint", () => {
  test("digests every regular file with POSIX-relative keys", () => {
    // GIVEN a tree with a nested file
    write("package.json", "{}");
    write("src/index.ts", "export const x = 1;");

    // WHEN it is fingerprinted
    const fp = computeFingerprint(root);

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
    write("install-meta.json", '{"name":"x"}');

    // WHEN it is fingerprinted excluding the sidecar
    const fp = computeFingerprint(root, ["install-meta.json"]);

    // THEN the sidecar is not part of the digest map
    expect(Object.keys(fp.files)).toEqual(["package.json"]);
  });

  test("skips symlinks", () => {
    // GIVEN a tree with a real file and a symlink to it
    write("real.txt", "hello");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));

    // WHEN it is fingerprinted
    const fp = computeFingerprint(root);

    // THEN only the regular file is digested
    expect(Object.keys(fp.files)).toEqual(["real.txt"]);
  });
});

describe("compareFingerprint", () => {
  test("reports clean when the tree is unchanged", () => {
    // GIVEN a fingerprinted tree
    write("a.txt", "one");
    write("b.txt", "two");
    const baseline = computeFingerprint(root);

    // WHEN it is compared against itself untouched
    const diff = compareFingerprint(root, baseline);

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
    const baseline = computeFingerprint(root);

    // AND the tree is edited: one file changed, one added, one removed
    write("change.txt", "after");
    write("new.txt", "fresh");
    rmSync(join(root, "keep.txt"));

    // WHEN the tree is compared against the baseline
    const diff = compareFingerprint(root, baseline);

    // THEN each change is bucketed correctly
    expect(diff.clean).toBe(false);
    expect(diff.modified).toEqual(["change.txt"]);
    expect(diff.added).toEqual(["new.txt"]);
    expect(diff.removed).toEqual(["keep.txt"]);
  });

  test("does not count an excluded sidecar as an addition", () => {
    // GIVEN a baseline computed with the sidecar excluded
    write("package.json", "{}");
    const baseline = computeFingerprint(root, ["install-meta.json"]);

    // AND the sidecar exists on disk (as it would post-install)
    write("install-meta.json", '{"name":"x"}');

    // WHEN compared with the same exclusion
    const diff = compareFingerprint(root, baseline, ["install-meta.json"]);

    // THEN the tree is still clean
    expect(diff.clean).toBe(true);
  });
});

describe("parseFingerprint", () => {
  test("round-trips a computed fingerprint through JSON", () => {
    // GIVEN a computed fingerprint serialized to JSON
    write("a.txt", "one");
    const fp = computeFingerprint(root);

    // WHEN it is parsed back
    const parsed = parseFingerprint(JSON.parse(JSON.stringify(fp)));

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
    const parsed = parseFingerprint(value);

    // THEN it is rejected leniently
    expect(parsed).toBeNull();
  });
});

describe("computeContentHash", () => {
  test("returns a v2-prefixed sha256 digest over the tree", () => {
    // GIVEN a tree with a nested file
    write("package.json", "{}");
    write("src/index.ts", "export const x = 1;");

    // WHEN the aggregate content hash is computed
    const hash = computeContentHash(root);

    // THEN it is the versioned sha256 hex format skills also use
    expect(hash).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("is independent of filesystem creation order", () => {
    // GIVEN two trees with identical contents written in different orders
    write("b.txt", "two");
    write("a.txt", "one");
    const first = computeContentHash(root);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    write("a.txt", "one");
    write("b.txt", "two");

    // WHEN both are hashed
    const second = computeContentHash(root);

    // THEN the digests match — the walk visits files in path order
    expect(second).toBe(first);
  });

  test("changes when any file content changes", () => {
    // GIVEN a baseline hash
    write("a.txt", "one");
    const baseline = computeContentHash(root);

    // AND a file is edited
    write("a.txt", "two");

    // WHEN the hash is recomputed
    const updated = computeContentHash(root);

    // THEN it differs from the baseline
    expect(updated).not.toBe(baseline);
  });

  test("excludes named top-level entries (the sidecar)", () => {
    // GIVEN a tree and a baseline computed with the sidecar excluded
    write("package.json", "{}");
    const baseline = computeContentHash(root, ["install-meta.json"]);

    // AND the sidecar later exists on disk (as it would post-install)
    write("install-meta.json", '{"name":"x"}');

    // WHEN the hash is recomputed with the same exclusion
    const after = computeContentHash(root, ["install-meta.json"]);

    // THEN the sidecar does not perturb the digest
    expect(after).toBe(baseline);
  });

  test("is not collision-prone across path/content boundaries", () => {
    // GIVEN two trees whose concatenated path+content bytes would collide
    // without length-prefixing ("ab" + "c" vs "a" + "bc")
    write("ab", "c");
    const first = computeContentHash(root);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    write("a", "bc");

    // WHEN both are hashed
    const second = computeContentHash(root);

    // THEN the length-prefixed scheme keeps them distinct
    expect(second).not.toBe(first);
  });
});

describe("generated app build output is excluded", () => {
  test("apps/<app>/dist is not fingerprinted, so a build is never drift", () => {
    // Installed source: an app with a src/ entry point (no dist yet).
    write("apps/dash/src/main.tsx", "export default 1;");
    write("hooks/stop.ts", "export default () => 1;");
    const baseline = computeFingerprint(root);
    expect(Object.keys(baseline.files)).toContain("apps/dash/src/main.tsx");

    // The watcher later compiles src -> apps/dash/dist. That generated output
    // must not surface as drift (added files) against the pinned commit.
    write("apps/dash/dist/main.js", "console.log(1)");
    write("apps/dash/dist/index.html", "<html></html>");
    const cmp = compareFingerprint(root, baseline);
    expect(cmp.clean).toBe(true);
    expect(cmp.added).toEqual([]);

    // A plugin's own top-level dist/ is still tracked (not an app build dir).
    write("dist/bundle.js", "x");
    expect(compareFingerprint(root, baseline).added).toEqual([
      "dist/bundle.js",
    ]);
  });

  test("content hash ignores apps/<app>/dist", () => {
    write("apps/dash/src/main.tsx", "export default 1;");
    const before = computeContentHash(root);
    write("apps/dash/dist/main.js", "console.log(1)");
    expect(computeContentHash(root)).toBe(before);
  });
});
