/**
 * Tests for app source fingerprinting: walk exclusions, comparison, inspect
 * statuses, and the compile-time sidecar format.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  compareAppSourceFingerprint,
  computeAppSourceFingerprint,
  inspectAppSource,
  parseAppSourceFingerprint,
  SOURCE_FINGERPRINT_FILENAME,
  writeAppSourceFingerprint,
} from "../apps/source-fingerprint.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "app-source-fingerprint-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

describe("computeAppSourceFingerprint", () => {
  test("digests source files with POSIX-relative keys", () => {
    write("src/main.tsx", "export const x = 1;");
    write("src/index.html", "<html></html>");

    const fp = computeAppSourceFingerprint(root);

    expect(Object.keys(fp.files).sort()).toEqual([
      "src/index.html",
      "src/main.tsx",
    ]);
    expect(fp.algorithm).toBe("sha256");
    expect(fp.files["src/main.tsx"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("skips dist, records, node_modules, and .git", () => {
    write("src/main.tsx", "src");
    write("dist/main.js", "compiled");
    write("records/rec-1.json", "{}");
    write("node_modules/pkg/index.js", "dep");
    write("src/node_modules/nested/index.js", "nested");
    write(".git/HEAD", "ref");
    write("src/.git/config", "nope");

    const fp = computeAppSourceFingerprint(root);

    expect(Object.keys(fp.files)).toEqual(["src/main.tsx"]);
  });

  test("skips symlinks", () => {
    write("src/real.tsx", "hello");
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync(join(root, "src/real.tsx"), join(root, "src/link.tsx"));

    const fp = computeAppSourceFingerprint(root);

    expect(Object.keys(fp.files)).toEqual(["src/real.tsx"]);
  });
});

describe("compareAppSourceFingerprint", () => {
  test("reports modified, added, and removed paths", () => {
    write("src/main.tsx", "one");
    write("src/keep.tsx", "keep");
    const baseline = computeAppSourceFingerprint(root);

    write("src/main.tsx", "two");
    write("src/new.tsx", "new");
    rmSync(join(root, "src/keep.tsx"));

    const diff = compareAppSourceFingerprint(root, baseline);
    expect(diff.clean).toBe(false);
    expect(diff.modified).toEqual(["src/main.tsx"]);
    expect(diff.added).toEqual(["src/new.tsx"]);
    expect(diff.removed).toEqual(["src/keep.tsx"]);
  });

  test("is clean when source matches the baseline", () => {
    write("src/main.tsx", "same");
    const baseline = computeAppSourceFingerprint(root);
    const diff = compareAppSourceFingerprint(root, baseline);
    expect(diff.clean).toBe(true);
    expect(diff.modified).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("inspectAppSource", () => {
  test("reports never_compiled when dist index is missing even if a fingerprint exists", () => {
    write("src/main.tsx", "src");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeAppSourceFingerprint(root, join(root, "dist"));

    const result = inspectAppSource(root);
    expect(result.status).toBe("never_compiled");
  });

  test("reports unknown_baseline when dist exists without a fingerprint", () => {
    write("src/main.tsx", "src");
    write("dist/index.html", "<html></html>");
    const result = inspectAppSource(root);
    expect(result.status).toBe("unknown_baseline");
  });

  test("reports clean after writing a fingerprint that matches source", () => {
    write("src/main.tsx", "src");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<html></html>");
    writeAppSourceFingerprint(root, join(root, "dist"));

    const result = inspectAppSource(root);
    expect(result.status).toBe("clean");
    expect(result.compiledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("reports stale after a source edit", () => {
    write("src/main.tsx", "before");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.html"), "<html></html>");
    writeAppSourceFingerprint(root, join(root, "dist"));
    write("src/main.tsx", "after");

    const result = inspectAppSource(root);
    expect(result.status).toBe("stale");
    expect(result.modified).toEqual(["src/main.tsx"]);
  });
});

describe("parseAppSourceFingerprint", () => {
  test("accepts a compile sidecar with compiledAt", () => {
    const parsed = parseAppSourceFingerprint({
      algorithm: "sha256",
      compiledAt: "2026-09-09T00:00:00.000Z",
      files: { "src/main.tsx": "abc" },
    });
    expect(parsed).toEqual({
      algorithm: "sha256",
      compiledAt: "2026-09-09T00:00:00.000Z",
      files: { "src/main.tsx": "abc" },
    });
  });

  test("returns null for an invalid sidecar", () => {
    expect(parseAppSourceFingerprint({ algorithm: "md5", files: {} })).toBe(
      null,
    );
    expect(parseAppSourceFingerprint(null)).toBeNull();
  });

  test("writeAppSourceFingerprint records a sidecar the parser accepts", () => {
    write("src/main.tsx", "src");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeAppSourceFingerprint(root, join(root, "dist"));
    const raw = JSON.parse(
      readFileSync(join(root, "dist", SOURCE_FINGERPRINT_FILENAME), "utf-8"),
    );
    expect(parseAppSourceFingerprint(raw)?.files["src/main.tsx"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
